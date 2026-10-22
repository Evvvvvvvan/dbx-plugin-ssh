<script lang="ts">
// Markdown 渲染/源码切换的会话级记忆：script-setup 顶层是实例作用域，
// 会话记忆须挂模块作用域（同会话多次打开预览沿用上次选择，不持久化）。
export type MarkdownView = "render" | "source";
let sessionMarkdownView: MarkdownView = "render";
</script>

<script setup lang="ts">
// 多格式预览弹窗（自 files 插件 PreviewPane 移植并适配 SSH sidecar）：
// 文本/代码走 CodeMirror，图片走原生元素，未知扩展走 text/hex 启发式；
// Office/PDF/媒体/表格/演示文稿/OFD/XMind/notebook 与 tiff/heic 等需解码的
// 图片交给 FileViewerPreview。二进制预览经 sftp/stat + sftp/read(offset) 分块
// 流式拼装（≤1MiB/片，≤256MiB）；sudo 模式走 sudo/readFile（≤4MiB/片）；
// 文本/可编辑链路仍走既有整读（≤1MiB）。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, Pencil, RefreshCw, X } from "@lucide/vue";
import { formatBytes } from "../lib/format";
import { canEditBytes, hexDump, PREVIEW_MAX_BYTES, READ_MAX_BYTES, SUDO_READ_MAX_BYTES } from "../lib/preview";
import { resolvePreview, type PreviewResolution } from "../lib/previewResolver";
import FileViewerPreview from "./FileViewerPreview.vue";
import MarkdownRender from "./MarkdownRender.vue";
import TextPreview from "./TextPreview.vue";

const props = defineProps<{
  path: string | null;
  sessionId: string | undefined;
  /** sudo 车道：读取走 sudo/readFile、写回走 sudo/writeFile。 */
  sudo: boolean;
  canWrite: boolean;
  /** 宿主外观（CodeMirror 主题色板，与 sftp 编辑器同方案）。 */
  appearance: DbxPluginAppearance;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "saved", path: string): void;
  (event: "download", path: string): void;
}>();

type PreviewMode = "text" | "image" | "hex" | "viewer";

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const editError = ref("");
const truncated = ref(false);
// 分块预览超硬上限（>256MiB 不进浏览器内存，保持「下载代替」出口）。
const overCap = ref(false);
const size = ref(0);
const mode = ref<PreviewMode>("text");
const editing = ref(false);
const text = ref("");
const draft = ref("");
const dataUri = ref("");
const hex = ref("");
const sourceFile = ref<File | null>(null);
const resolution = ref<PreviewResolution | null>(null);

// Markdown 渲染视图：md 文件默认渲染面，头部「渲染/源码」分段切换。
const mdView = ref<MarkdownView>(sessionMarkdownView);
const isMarkdown = computed(() => resolution.value?.mime === "text/markdown");
const showMdToggle = computed(() => Boolean(
  isMarkdown.value
  && mode.value === "text"
  && !editing.value
  && !loading.value
  && !error.value,
));
function setMarkdownView(view: MarkdownView) {
  mdView.value = view;
  sessionMarkdownView = view;
}
// i18n key 未入库时返回 key 本身，据此回退到组件内置兜底文案。
function mdLabel(key: string, fallback: string): string {
  const value = props.t(key);
  return value === key ? fallback : value;
}

const title = computed(() => (props.path ? props.path.split(/[\\/]/).pop() ?? props.path : ""));
/** 非 UTF-8 文本（按 GB18030 展示）：编辑必须停用——TextEncoder 只按 UTF-8
 *  写回，保存会把 GB18030 字节整体替换成乱码并永久写坏远端文档。 */
const nonUtf8 = ref(false);
const canEdit = computed(() => Boolean(
  resolution.value?.editable
  && props.canWrite
  && !truncated.value
  && !loading.value
  && !error.value
  && mode.value === "text"
  && !editing.value
  && !nonUtf8.value,
));
const showEditbar = computed(() => Boolean(
  resolution.value?.editable
  && props.canWrite
  && !truncated.value
  && !loading.value
  && !error.value
  && mode.value === "text",
));

// 打开时把焦点移入预览，卸载时归还触发元素。
const previewEl = ref<HTMLElement>();
const textPreviewRef = ref<InstanceType<typeof TextPreview>>();
let returnFocusTo: HTMLElement | null = null;

onMounted(async () => {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  previewEl.value?.focus();
});

onUnmounted(() => {
  if (returnFocusTo?.isConnected) returnFocusTo.focus();
  returnFocusTo = null;
});

watch(editing, async (on) => {
  if (!on) return;
  await nextTick();
  (textPreviewRef.value as unknown as { focus?: () => void } | undefined)?.focus?.();
});

const perChunkBytes = computed(() => (props.sudo ? SUDO_READ_MAX_BYTES : READ_MAX_BYTES));

function readOnce(path: string, offset: number, length: number) {
  if (props.sudo) {
    return window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sudo/readFile", {
      sessionId: props.sessionId,
      path,
      offset,
      length,
    });
  }
  return window.dbxPlugin.invoke<{ dataBase64: string; truncated: boolean }>("sftp/read", {
    sessionId: props.sessionId,
    path,
    offset,
    maxBytes: length,
  });
}

async function load() {
  if (!props.path) return;
  loading.value = true;
  saving.value = false;
  editing.value = false;
  error.value = "";
  editError.value = "";
  dataUri.value = "";
  hex.value = "";
  sourceFile.value = null;
  resolution.value = resolvePreview(props.path);
  mdView.value = sessionMarkdownView;
  text.value = "";
  draft.value = "";
  size.value = 0;
  truncated.value = false;
  overCap.value = false;
  nonUtf8.value = false;
  // 换文件即失效进行中的分块循环与读取请求（token 检查点见 runChunkLoop）。
  loadToken += 1;
  const token = loadToken;
  chunkCancelRequested.value = false;
  chunkActive.value = false;
  loadedBytes.value = 0;
  totalBytes.value = 0;
  parts = [];
  revokeObjectUrl();
  try {
    // 二进制预览（图片/媒体/Office/PDF）：stat 取大小 → read 分块流式拼装；
    // 文本/代码与未知扩展仍走整读（可编辑链路不动）。
    if (resolution.value.previewStrategy === "image" || resolution.value.previewStrategy === "file-viewer") {
      await loadChunked(resolution.value);
      return;
    }
    const result = await readOnce(props.path, 0, perChunkBytes.value);
    // 过期响应一律作废，状态归新一次 load 所有。
    if (token !== loadToken) return;
    const bytes = window.dbxPlugin.decodeBase64(result.dataBase64);
    truncated.value = Boolean(result.truncated);
    // sudo/readFile 不回 size；整读语义下已加载字节即展示大小。
    size.value = result.truncated ? bytes.byteLength : bytes.byteLength;
    // 文本/代码与未知扩展：先按 UTF-8 严格解码；失败（GBK 等非 UTF-8）回退
    // GB18030 展示并停用编辑。
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      nonUtf8.value = false;
    } catch {
      decoded = new TextDecoder("gb18030").decode(bytes);
      nonUtf8.value = true;
    }
    if (resolution.value.previewStrategy === "hex" && looksBinaryText(decoded)) {
      mode.value = "hex";
      hex.value = hexDump(bytes.subarray(0, 512));
      return;
    }
    mode.value = "text";
    text.value = decoded;
    draft.value = decoded;
  } catch (cause) {
    if (token !== loadToken) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    // 只有当前这一次 load 才能收 loading；过期请求的 finally 不得干预。
    if (token === loadToken) loading.value = false;
  }
}

/** 未知扩展的可读性启发式（files 同款 printable 比例判定）：不可读比例 >8% 走 hex。 */
function looksBinaryText(decoded: string): boolean {
  if (!decoded.length) return false;
  const printable = decoded.replace(/[^\t\n\r\x20-\x7E\u00A0-\uFFFF]/g, "");
  return 1 - printable.length / decoded.length > 0.08;
}

// --- 二进制预览分块流式加载（sftp/stat + sftp/read offset）--------------------
// 按 1MiB/片（sudo 车道 4MiB）顺序拉取（并发 1）拼装成单个 Blob，进度条以
// 「已取字节 / totalSize」渲染；取消在分片间隙打断并干净关闭；失败保留已取
// 字节，可从失败 offset 续传。eof / 取满 totalSize 即收口。

const chunkActive = ref(false);
const chunkCancelRequested = ref(false);
const loadedBytes = ref(0);
const totalBytes = ref(0);
const chunkPercent = computed(() => {
  if (!totalBytes.value) return 0;
  return Math.min(100, Math.round((loadedBytes.value / totalBytes.value) * 100));
});
/** 分块循环的失效令牌：换文件/取消时自增，旧循环在下一个检查点退出。 */
let loadToken = 0;
/** 已取分片（非响应式：大数组逐片 push 不应触发渲染）。 */
let parts: Uint8Array[] = [];
let objectUrl = "";

function revokeObjectUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  }
}

onUnmounted(revokeObjectUrl);

async function loadChunked(resolution: PreviewResolution) {
  // token 在本函数入口捕获并贯穿整个分块链路：stat 是第一个 await，
  // 旧一次 load 的 stat 迟到时会用旧文件的大小覆盖新一轮状态。
  const token = loadToken;
  const total = await fetchTotalSize();
  if (token !== loadToken) return;
  size.value = total;
  totalBytes.value = total;
  if (total > PREVIEW_MAX_BYTES) {
    overCap.value = true;
    return;
  }
  if (total === 0) {
    finishChunkPreview(resolution);
    return;
  }
  chunkActive.value = true;
  parts = [];
  loadedBytes.value = 0;
  await runChunkLoop(resolution, 0, token);
}

/** sudo/readFile 无 stat 语义、也不回 totalSize：sudo 车道按单片截断累计，
 * 文件真实大小未知（进度显示已取字节）；普通车道 sftp/stat 取精确 total。 */
async function fetchTotalSize(): Promise<number> {
  if (props.sudo) return 0;
  try {
    const stat = await window.dbxPlugin.invoke<{ size?: number }>("sftp/stat", {
      sessionId: props.sessionId,
      path: props.path,
    });
    return Number(stat.size ?? 0);
  } catch {
    return 0;
  }
}

/** 分片循环：顺序（并发 1）拉取；token/取消在每个 await 后检查。 */
async function runChunkLoop(resolution: PreviewResolution, fromOffset: number, token: number) {
  try {
    let offset = fromOffset;
    // total=0 表示大小未知（sudo 车道 / stat 失败）：靠 truncated 语义收口。
    const total = () => totalBytes.value;
    while (!total() || offset < total()) {
      if (token !== loadToken || chunkCancelRequested.value) return;
      const length = total() ? Math.min(perChunkBytes.value, total() - offset) : perChunkBytes.value;
      const result = await readOnce(props.path ?? "", offset, length);
      if (token !== loadToken || chunkCancelRequested.value) return;
      const chunk = window.dbxPlugin.decodeBase64(result.dataBase64);
      parts.push(chunk);
      // 0 字节响应按请求长度推进，避免坏实现卡死循环。
      offset += chunk.byteLength || length;
      loadedBytes.value = offset;
      // 大小未知车道：truncated 表示还有后续，继续下一片；否则收口。
      if (!total() && !result.truncated) break;
      if (total() && offset >= total()) break;
    }
    finishChunkPreview(resolution);
  } catch (cause) {
    if (token !== loadToken || chunkCancelRequested.value) return;
    // 保留已取字节与 chunkActive：错误面板给出「从失败 offset 重试」。
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

/** 拼装收口：image → object URL；viewer → File 交给既有渲染。 */
function finishChunkPreview(resolution: PreviewResolution) {
  chunkActive.value = false;
  const blob = new Blob(parts as BlobPart[], { type: resolution.mime ?? "application/octet-stream" });
  // 成功收口后释放分片：Blob 已自持数据，parts 继续被模块级变量持有等于双倍内存。
  parts = [];
  if (resolution.previewStrategy === "image") {
    mode.value = "image";
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      revokeObjectUrl();
      objectUrl = URL.createObjectURL(blob);
      dataUri.value = objectUrl;
    }
    return;
  }
  mode.value = "viewer";
  sourceFile.value = new File([blob], title.value || "file", { type: blob.type });
}

/** 取消：打断剩余分片并干净关闭（不落错误 UI）。 */
function cancelChunkLoad() {
  if (!chunkActive.value) return;
  chunkCancelRequested.value = true;
  chunkActive.value = false;
  parts = [];
  emit("close");
}

/** 失败续传：从已取 offset 继续拉剩余分片（沿用原 resolution 渲染链路）。 */
async function resumeChunkLoad() {
  if (!props.path || !resolution.value || loading.value) return;
  error.value = "";
  chunkCancelRequested.value = false;
  chunkActive.value = true;
  loading.value = true;
  try {
    await runChunkLoop(resolution.value, Math.min(loadedBytes.value, totalBytes.value), loadToken);
  } finally {
    loading.value = false;
  }
}

function handleViewerError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : String(cause);
}

function startEdit() {
  if (!canEdit.value) return;
  draft.value = text.value;
  editError.value = "";
  editing.value = true;
}

function cancelEdit() {
  draft.value = text.value;
  editError.value = "";
  editing.value = false;
}

async function saveEdit() {
  if (!props.path || saving.value) return;
  editError.value = "";
  const bytes = new TextEncoder().encode(draft.value);
  if (!canEditBytes(bytes.byteLength)) {
    editError.value = props.t("sftpAttrs.sizeLimit");
    return;
  }
  saving.value = true;
  try {
    const dataBase64 = window.dbxPlugin.encodeBase64(bytes);
    if (props.sudo) {
      await window.dbxPlugin.invoke("sudo/writeFile", { sessionId: props.sessionId, path: props.path, dataBase64 });
    } else {
      await window.dbxPlugin.invoke("sftp/write", { sessionId: props.sessionId, remotePath: props.path, dataBase64 });
    }
    text.value = draft.value;
    size.value = bytes.byteLength;
    editing.value = false;
    emit("saved", props.path);
  } catch (cause) {
    editError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.path,
  () => {
    if (props.path) void load();
  },
  { immediate: true },
);

// 向外暴露未保存草稿状态——App 侧关闭预览（Esc/遮罩/关闭钮）时，
// 编辑中且草稿已改动先弹丢弃确认，防止静默丢失 CodeMirror 编辑内容。
const isDirty = computed(() => editing.value && draft.value !== text.value);
defineExpose({ isDirty });

// viewer 渲染不了的文档类格式（pptx 等未装配 renderer / 损坏文件）：提示改用
// 平台外部应用打开（或下载）。
const canOpenExternal = computed(() =>
  resolution.value?.kind === "office" || resolution.value?.kind === "pdf" || resolution.value?.kind === "media",
);
</script>

<template>
  <div v-if="path" ref="previewEl" tabindex="-1" class="ssh-preview" data-test="ssh-preview">
    <div class="ssh-preview-header">
      <strong :title="path">{{ title }}</strong>
      <span class="ssh-preview-meta">{{ loading || mode === "image" || mode === "viewer" ? "" : formatBytes(size) }}</span>
      <!-- Markdown 渲染/源码切换（仅 md 文本态出现；i18n key 缺失用兜底文案）。 -->
      <span v-if="showMdToggle" class="ssh-preview-md-toggle" data-test="md-toggle">
        <button
          type="button"
          class="ssh-preview-chip"
          :class="{ 'ssh-preview-chip-active': mdView === 'render' }"
          data-test="md-render"
          :aria-pressed="mdView === 'render'"
          @click="setMarkdownView('render')"
        >{{ mdLabel("previewDialog.mdRenderView", "渲染") }}</button>
        <button
          type="button"
          class="ssh-preview-chip"
          :class="{ 'ssh-preview-chip-active': mdView === 'source' }"
          data-test="md-source"
          :aria-pressed="mdView === 'source'"
          @click="setMarkdownView('source')"
        >{{ mdLabel("previewDialog.mdSourceView", "源码") }}</button>
      </span>
      <button v-if="canEdit && !saving" type="button" class="ssh-preview-action" data-test="preview-edit" :title="t('editSave.edit')" @click="startEdit"><Pencil />{{ t("editSave.edit") }}</button>
      <button type="button" class="ssh-preview-action" :title="t('previewDialog.download')" :aria-label="t('previewDialog.download')" @click="emit('download', path)"><Download /></button>
      <button type="button" class="ssh-preview-action ssh-preview-close" :title="t('close')" :aria-label="t('close')" @click="emit('close')"><X /></button>
    </div>
    <div v-if="nonUtf8 && mode === 'text' && !loading && !error" class="ssh-preview-editbar" data-test="nonutf8-hint">{{ t("previewDialog.nonUtf8") }}</div>
    <div v-if="showEditbar" class="ssh-preview-editbar">
      <template v-if="editing">
        <span v-if="editError" class="ssh-preview-edit-error" data-test="edit-error">{{ editError }}</span>
        <button type="button" class="ssh-preview-chip" :disabled="saving" @click="cancelEdit">{{ t("cancel") }}</button>
        <button type="button" class="ssh-preview-chip ssh-preview-chip-primary" :disabled="saving" @click="saveEdit">{{ t("editSave.save") }}</button>
      </template>
      <span v-else class="ssh-preview-meta">{{ t("editSave.edit") }}</span>
    </div>
    <!-- 分块加载进度（二进制预览）：字节进度 + 取消；失败后保留以便续传重试。 -->
    <div v-if="chunkActive" class="ssh-preview-editbar" data-test="chunkbar">
      <span class="ssh-preview-meta">{{ t("previewDialog.chunkProgress", { done: formatBytes(loadedBytes), total: totalBytes ? formatBytes(totalBytes) : "" }) }}</span>
      <div class="ssh-preview-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="totalBytes ? chunkPercent : undefined"><div class="ssh-preview-progress-bar" :style="{ width: `${totalBytes ? chunkPercent : 50}%` }" /></div>
      <button type="button" class="ssh-preview-chip" data-test="chunk-cancel" @click="cancelChunkLoad">{{ t("cancel") }}</button>
    </div>
    <div class="ssh-preview-body" :aria-busy="loading">
      <template v-if="loading">
        <div class="ssh-preview-skeleton">
          <span role="status" class="ssh-preview-meta">{{ t("loading") }}</span>
          <span v-for="row in 8" :key="row" class="ssh-preview-skeleton-row" aria-hidden="true" :style="{ width: `${100 - (row % 3) * 12}%` }" />
        </div>
      </template>
      <div v-else-if="error" class="ssh-preview-notice" data-test="preview-error">
        <div>{{ t("previewDialog.loadError", { error }) }}</div>
        <div v-if="canOpenExternal" class="ssh-preview-meta">{{ t("previewDialog.externalHint") }}</div>
        <div class="ssh-preview-actions-row">
          <!-- 分块失败续传：从失败 offset 继续（>0 才有意义）。 -->
          <button v-if="chunkActive && loadedBytes" type="button" class="ssh-preview-chip" data-test="chunk-retry" @click="resumeChunkLoad"><RefreshCw /> {{ t("previewDialog.retryFromOffset", { offset: loadedBytes }) }}</button>
          <button type="button" class="ssh-preview-chip" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
        </div>
      </div>
      <img v-else-if="mode === 'image'" class="ssh-preview-image" :src="dataUri" :alt="title" />
      <!-- Markdown 渲染视图：白名单子集 + 全量 HTML 转义；解析异常回退源码。 -->
      <MarkdownRender
        v-else-if="mode === 'text' && showMdToggle && mdView === 'render'"
        :text="text"
        @render-error="setMarkdownView('source')"
      />
      <!-- 文本预览/编辑：CodeMirror（与 sftp 面板同方案）；key 保证进入/退出
           编辑都从 props.text 全新装载，取消编辑即回滚草稿。 -->
      <TextPreview
        v-else-if="mode === 'text'"
        ref="textPreviewRef"
        :key="editing ? 'edit' : 'read'"
        :text="text"
        :file-name="title"
        :appearance="appearance"
        :editable="editing"
        @change="draft = $event"
      />
      <pre v-else-if="mode === 'hex'" class="ssh-preview-hex">{{ hex }}</pre>
      <FileViewerPreview
        v-else-if="mode === 'viewer' && sourceFile"
        :source="sourceFile"
        :file-name="title"
        :mime="resolution?.mime ?? undefined"
        :appearance="appearance"
        class="ssh-preview-viewer"
        @error="handleViewerError"
      />
      <div v-else class="ssh-preview-notice">{{ t("previewDialog.unsupported") }}</div>
    </div>
    <div v-if="truncated" class="ssh-preview-banner" data-test="truncated">
      <span>{{ t("previewDialog.truncatedNotice", { size: formatBytes(perChunkBytes) }) }}</span>
      <button type="button" class="ssh-preview-chip" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
    </div>
    <!-- 分块预览超硬上限（>256MiB）：不进浏览器内存，保持「下载代替」出口。 -->
    <div v-if="overCap" class="ssh-preview-banner" data-test="overcap">
      <span>{{ t("previewDialog.overCap", { size: formatBytes(PREVIEW_MAX_BYTES) }) }}</span>
      <button type="button" class="ssh-preview-chip" @click="emit('download', path)"><Download /> {{ t("previewDialog.download") }}</button>
    </div>
  </div>
</template>
