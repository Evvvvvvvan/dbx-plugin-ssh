# 自适应 SFTP 传输引擎一期 — 性能实测报告

> 分支 `codex/ssh/sftp-adaptive-turbo`（lzpack `53e7b89b` + 12 分支收编 + P3 闭环 `30e15596`）。
> 测试环境：macOS arm64（Apple Silicon）、Docker linuxserver/openssh-server（本机 loopback）、
> debug 构建 sidecar、smoke/sidecar_client 驱动（每块一次 RPC 的 Python 客户端，非前端生产路径）。

## 1. 自研 lzpack 编解码器（微基准，release 构建，32 MiB 样本）

| 数据类型 | 压缩率 | 压缩吞吐 | 解压吞吐 |
|---|---|---|---|
| 随机数据（不可压） | 1.00x（RAW 块回退，不膨胀） | 126 MiB/s | 5.9 GiB/s |
| 文本类（词表随机组合） | 1.67x | 137 MiB/s | 212 MiB/s |
| 重复数据 | 988x | 387 MiB/s | 621 MiB/s |

- 压缩吞吐显著低于 flate2/gzip（约 1/3）：显式模式由用户权衡，自动决策必须实测驱动——这正是
  `transfer_schedule::decide()` 只信实测值、无实测即保守直传的原因。
- 随机数据解压 5.9 GiB/s：RAW 块直拷路径，恶意/损坏文件的防护校验不构成吞吐瓶颈。

## 2. 端到端真机实测（100 MiB 文本 / 20 MiB 随机，loopback SSH+SFTP）

| 场景 | 耗时 | 吞吐 | 备注 |
|---|---|---|---|
| 文本 100MiB lzpack 上传（spool→压缩→推送→提交 .dbxz） | 15.9s | 6.3 MiB/s | 压缩率 **0.609**（100→60.9 MiB，网络腿少传 39%） |
| 文本 100MiB lzpack 解压下载（拉流→解压→staged 供给） | 7.9s | 12.6 MiB/s | 拉流 60.9MiB + 解压全量 |
| 文本 100MiB 直传上传 | 6.7s | 14.9 MiB/s | |
| 文本 100MiB 直传下载 | 28.4-30.0s | 3.3-3.5 MiB/s | 两次一致；受逐块 RPC IPC 往返主导 |
| 随机 20MiB lzpack 上传 | 2.6s | 7.8 MiB/s | ratio 1.000（RAW 回退，零膨胀） |
| 随机 20MiB 直传上传 | 1.4s | 14.0 MiB/s | |

**解读（诚实口径）**：

1. **本机 loopback 不是 lzpack 的主场**。loopback 带宽远超压缩吞吐（137 MiB/s），
   压缩/解压 CPU 段反而成为净开销——直传上传 14.9 vs lzpack 6.3 MiB/s 即此效应。
   lzpack 的收益公式是 `r·S/B`（省 39% 网络字节）：带宽 ≤ 数十 MiB/s 的真实广域/VPN/
   跳板链路上，文本类文件压缩交付才有净收益。这正解释了为什么显式模式是正确的产品
   形态，且 advisor 在「带宽 EMA 高 + codec 慢」时建议直传。
2. **直传下载 3.3-3.5 MiB/s 的瓶颈是测试驱动**：Python 客户端每块一次 RPC（256KiB/块，
   含 IPC 往返与帧泵）。前端生产路径在同一模型下运行，但预取（ST9）把「每块一个远端
   RTT」变为「命中本地槽」，收益集中在高 RTT 网络（100ms RTT 理论提升一个量级）；
   loopback RTT <1ms，预取收益被 IPC 往返掩盖——预期内，非回归。
3. **lzpack 下载 12.6 MiB/s 快于直传下载**：staged 供给是纯本地文件读；网络腿已由
   prep 异步完成。分阶段进度（fetching→decompressing→ready→transferring）让这个
   结构在 UI 上是透明的。

## 3. 决策器（advisor）行为验证

- `decide()` 纯函数 8 例 + advisor 3 例单测全过：数据缺失 → Direct/NoData（不臆测）；
  正收益达门槛（缺省 10%）→ Compressed/Endorse；负收益 → Direct/RecommendDirect。
- 顾问只产日志不拦截（显式模式契约）；`is_confident`（≥3 次带宽观测）门槛防止
  少量样本误导用户。
- `connection/disconnect` 清理档案，重连不背历史包袱。

## 4. 跨平台构建验证

| 目标 | 结果 |
|---|---|
| aarch64-apple-darwin（本机） | build + 1295 测试全过 |
| x86_64-unknown-linux-musl（CI linux-x64 同款） | `cargo check` 通过（musl-cross 工具链） |
| aarch64-unknown-linux-musl（CI linux-arm64 同款） | `cargo check` 通过 |
| x86_64-pc-windows-msvc（CI windows-2022 job） | 本地无 MSVC 工具链（libz-sys C 编译需 cl.exe），**交由 CI 必过门**；本次改动无平台相关代码（纯 std/tokio API，无 cfg 分支），风险低 |

## 5. 当前限制与后续

1. lzpack 压缩吞吐 ~137 MiB/s（gzip 的 1/3）：后续可加哈希链扩链（`MAX_MATCH_PROBES`
   常量已预留）提压缩率，代价是吞吐；当前文本 1.67x 已可用。
2. 下载预取仅普通单文件车道：树/压缩/latin-1/限速任务待覆盖。
3. 高 RTT 链路的端到端预取收益未实测（无 tc netem 环境），理论依据与实现已在
   PROTOCOL ST9 节声明。
4. Windows 构建/测试依赖 CI windows-2022 job（本地无法等价）。
