// @vitest-environment happy-dom
// SettingsDialog 组件测试（#137 跟进）：会话级门控的三态行为——
//   1. 本地终端（无 sessionId）：不拉 ssh/settings/get、不出「加载失败」横幅、
//      sudo/智能体会话级分类从导航隐藏（原先渲染为可编辑却永不可保存的死 UI）。
//   2. SSH 会话：ssh/settings/get 携 sessionId + revealSecrets 拉取，导航 11 项。
// 设置壳是 reka Dialog：内容 portal 到 document.body，直接查询 body DOM
// （wrapper.find 看不到 portal 内容），与 FolderPickerDialog.spec 同法。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SettingsDialog from "./SettingsDialog.vue";
import { pluginStore } from "../lib/pluginStore";
import { workbenchMessage } from "../lib/i18n";
import { TERMINAL_BEHAVIOR_DEFAULTS } from "../lib/terminalBehavior";
import { ACTION_IDS, type TerminalHotkeyBindings } from "../lib/terminalHotkeys";
import { ACTION_LINK_SETTINGS_DEFAULTS } from "../lib/actionLinksMatcher";
import { DEFAULT_TERMINAL_APPEARANCE_SETTINGS } from "../lib/terminalAppearance";
import { GUTTER_TIMESTAMP_DEFAULT_FORMAT } from "../lib/terminalGutter";

const t = (key: string, values?: Record<string, string | number>) => workbenchMessage("zh-CN", key, values);

/** revealSecrets 预填形状的最小合法 SshSettings（字段见 lib/settingsModel.ts）。 */
const SSH_SETTINGS_META = {
  quickSudo: false,
  sudoUsePty: false,
  sudoPasswordSet: false,
  totpConfigured: false,
  authFlowMode: "password_then_otp",
  passwordPromptHint: "",
  totpPromptHint: "",
  sudoPassword: "",
  totpSecret: "",
  quickSudoProfileId: "",
  agentTerminalMode: "off",
  rememberedCommands: [],
};

/**
 * 宽容 mock：ssh/settings/get 按 meta 决定成功/失败；列表类方法按各自载荷
 * 形状返回空表（赋值端如 `sudoProfiles.value = result.profiles` 无 `?? []`，
 * 返回 {} 会把 undefined 写进 ref 再炸渲染）；其余 local/preferences/* 读写
 * 返回空对象（组件按默认值分支处理）。
 */
function installInvoke(meta: Record<string, unknown> | null) {
  const invoke = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === "ssh/settings/get") {
      if (meta === null) throw new Error("settings get failed (mock)");
      return meta;
    }
    if (method === "sudo/profiles/list") return { profiles: [] };
    if (method === "ssh/knownHosts/list") return { entries: [] };
    if (method === "keys/discover") return { keys: [] };
    if (method === "local/shells/list") return { shells: [] };
    if (method === "mcp/settings/get") {
      // 缺数值会让 MCP 面板的行内校验亮错（渲染期计算，无需保存动作）。
      return {
        maxReadBytes: 8 * 1024 * 1024,
        maxUploadBytes: 64 * 1024 * 1024,
        maxDownloadBytes: 256 * 1024 * 1024,
        execPermissionMode: "autonomous",
        connectionScope: [],
      };
    }
    return {};
  });
  (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { invoke };
  return invoke;
}

const hotkeyBindings = Object.fromEntries(ACTION_IDS.map((id) => [id, []])) as unknown as TerminalHotkeyBindings;

function mountSettings(sessionId?: string) {
  return mount(SettingsDialog, {
    attachTo: document.body,
    props: {
      open: false,
      ghostTabAccept: false,
      aiSettings: { search: true, fix: false, assist: true, agentMode: false, fixConsent: false },
      aiBridgeReady: false,
      promptHintsEnabled: true,
      profilesOpen: false,
      sessionId,
      terminalFontSize: 14,
      hostFontSize: 14,
      hostFontFamily: "monospace",
      localDownloadDir: "/tmp",
      localCanSave: true,
      webglEnabled: false,
      localShell: "/bin/zsh",
      terminalBehavior: { ...TERMINAL_BEHAVIOR_DEFAULTS },
      paneDirection: "auto",
      terminalHotkeys: hotkeyBindings,
      applePlatform: false,
      actionLinks: { ...ACTION_LINK_SETTINGS_DEFAULTS, matchers: { ...ACTION_LINK_SETTINGS_DEFAULTS.matchers } },
      gutter: { showLineNumbers: true, showTimestamps: false, timestampFormat: GUTTER_TIMESTAMP_DEFAULT_FORMAT },
      ctxSearchEngines: "",
      wallpaperEnabled: false,
      wallpaperOpacity: 50,
      wallpaperSessionOnly: false,
      appearance: {
        settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS },
        font: { family: null, size: null },
        customSchemes: [],
        customThemes: [],
      },
      customThemes: [],
      activeThemeId: null,
      hostTheme: {
        background: "#000000",
        foreground: "#ffffff",
        cursor: "#ffffff",
        cursorAccent: "#000000",
        selectionBackground: "#264f78",
      },
      hostColorScheme: "dark",
      downloadPrefs: {
        loadDir: () => "",
        loadUseDefault: () => true,
        loadConflict: () => "rename",
        persistDir: () => {},
        persistUseDefault: () => {},
        persistConflict: () => {},
      },
      transferPrefs: {
        loadConcurrency: () => 3,
        loadDuplicatePolicy: () => "rename",
        persistConcurrency: () => {},
        persistDuplicatePolicy: () => {},
        loadMaxActive: () => 4,
        loadCompatMode: () => false,
        loadNameEncoding: () => "auto",
        persistMaxActive: () => {},
        persistCompatMode: () => {},
        persistNameEncoding: () => {},
        loadDownloadLimit: () => 0,
        persistDownloadLimit: () => {},
        loadCompressMode: () => "auto",
        loadCompressThreshold: () => 100,
        persistCompressMode: () => {},
        persistCompressThreshold: () => {},
      },
      editorPrefs: {
        loadConfig: () => ({ associations: [], customEditors: [], uploadPolicy: "auto" as const }),
        persistConfig: () => undefined,
        loadEditors: () => [],
        reloadEditors: async () => [],
      },
      suggestionPrefs: {
        loadEnabled: () => true,
        loadMinChars: () => 2,
        loadMaxChars: () => 100,
        persistEnabled: () => {},
        persistMinChars: () => {},
        persistMaxChars: () => {},
      },
      highlightRules: [],
      highlightSaving: false,
      highlightDisplayMode: "bg",
      quickCommands: [],
      quickSaving: false,
      quickImporting: false,
      t,
    },
  });
}

async function openDialog(wrapper: ReturnType<typeof mountSettings>) {
  // open 的 watch 非 immediate：false→true 触发 reloadSettings，断言才非空洞。
  await wrapper.setProps({ open: true });
  await flushPromises();
}

const navLabels = () =>
  [...document.body.querySelectorAll<HTMLElement>(".settings-nav-item")].map((el) => (el.textContent ?? "").trim());

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("SettingsDialog 会话级门控", () => {
  it("本地终端：跳过 ssh/settings/get、不出失败横幅、sudo/智能体分类隐藏", async () => {
    const invoke = installInvoke(null);
    const wrapper = mountSettings(undefined);
    await openDialog(wrapper);

    const methods = invoke.mock.calls.map((call) => call[0]);
    expect(methods, "本地终端不得拉取会话级设置").not.toContain("ssh/settings/get");
    // 加载失败横幅是带 role="alert" 的 div；.task-error 还有别处行内校验在用。
    expect(document.body.querySelector('div.task-error[role="alert"]'), "不出「SSH 设置加载失败」横幅").toBeNull();

    const nav = navLabels();
    // 2026-10 反馈迭代：命令建议（suggestions）从终端分栏拆出独立成栏。
    // AI 助手（Warp AI 对齐批）为全局分类后本地导航 11 项。
    expect(nav).toHaveLength(11);
    // 命令建议是全局分类（本地终端同样可用）；sudo/智能体才是会话级隐藏。
    expect(nav).toContain(workbenchMessage("zh-CN", "settingsNav.suggestions"));
    for (const labelKey of ["settingsNav.sudo", "agentTerminalSection"]) {
      expect(nav).not.toContain(workbenchMessage("zh-CN", labelKey));
    }
    wrapper.unmount();
  });

  it("SSH 会话：携带 sessionId + revealSecrets 拉取，导航 13 项含 sudo/智能体", async () => {
    const invoke = installInvoke(SSH_SETTINGS_META);
    const wrapper = mountSettings("sess-1");
    await openDialog(wrapper);

    const getCalls = invoke.mock.calls.filter(([method]) => method === "ssh/settings/get");
    expect(getCalls, "会话级设置恰好拉取一次").toHaveLength(1);
    expect(getCalls[0]![1]).toMatchObject({ sessionId: "sess-1", revealSecrets: true });

    const nav = navLabels();
    // 同上：命令建议独立成栏 + AI 助手（Warp AI 对齐批）后 SSH 会话导航 13 项。
    expect(nav).toHaveLength(13);
    for (const labelKey of ["settingsNav.suggestions", "settingsNav.sudo", "agentTerminalSection"]) {
      expect(nav).toContain(workbenchMessage("zh-CN", labelKey));
    }
    wrapper.unmount();
  });
});

describe("SettingsDialog 字体控件回显（#219）", () => {
  afterEach(() => {
    pluginStore.removeItem("ssh-terminal-font-family");
    pluginStore.removeItem("ssh-terminal-font-size");
  });

  const customInput = () =>
    [...document.body.querySelectorAll<HTMLInputElement>("input")].find((el) =>
      (el.placeholder || "").includes("Fira Code"),
    );
  const sizeInput = () =>
    [...document.body.querySelectorAll<HTMLInputElement>("input")].find(
      (el) => el.type === "number" && el.closest("label")?.querySelector("span")?.textContent === t("terminalFont.size"),
    );

  it("开窗按持久化覆盖态回显字体；字号草稿跟随生效字号而非 setup 时刻", async () => {
    // 直接经 pluginStore 种子：store 水合是异步的（等宿主 init），直写
    // localStorage 会因缓存未水合而读不到。
    pluginStore.setItem("ssh-terminal-font-family", "Maple Mono NF");
    pluginStore.setItem("ssh-terminal-font-size", "14");
    installInvoke(null);
    const wrapper = mountSettings(undefined);
    // 弹窗常驻挂载：setup 时刻的字号是宿主基准（13），外部链路（Ctrl+滚轮/
    // 主题落地）随后把生效字号推到 14——开窗回显必须读到 14 而非陈旧草稿。
    await wrapper.setProps({ terminalFontSize: 14, open: true });
    await flushPromises();
    expect(customInput()?.value).toBe("Maple Mono NF");
    expect(sizeInput()?.value).toBe("14");
    wrapper.unmount();
  });

  it("恢复默认后字体控件立即回显跟随宿主（不再残留旧自定义字体）", async () => {
    pluginStore.setItem("ssh-terminal-font-family", "Maple Mono NF");
    installInvoke(null);
    const wrapper = mountSettings(undefined);
    await openDialog(wrapper);
    expect(customInput()?.value).toBe("Maple Mono NF");
    const reset = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes(t("terminalAppearance.reset")),
    );
    expect(reset).toBeTruthy();
    reset!.click();
    await flushPromises();
    const emittedThemes = wrapper.emitted("apply-theme");
    expect(emittedThemes?.length).toBeGreaterThan(0);
    // 跟随宿主预设 font 为 null：自定义输入框折叠（choice 回跟随宿主）。
    expect(customInput()).toBeUndefined();
    wrapper.unmount();
  });

  it("弹窗开着时字号 prop 变化，字号草稿跟随生效值", async () => {
    installInvoke(null);
    const wrapper = mountSettings(undefined);
    await openDialog(wrapper);
    await wrapper.setProps({ terminalFontSize: 16 });
    await flushPromises();
    expect(sizeInput()?.value).toBe("16");
    wrapper.unmount();
  });
});
