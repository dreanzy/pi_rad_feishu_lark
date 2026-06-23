import { msg, t } from "./locale.js";

export function modelLabel(model: any) {
  if (!model) return msg("model.not_selected");
  return `${model.provider}/${model.id}`;
}

export type ResumeScope = "current" | "all";

export type ResumeSessionItem = {
  path: string;
  title: string;
  subtitle: string;
  modifiedLabel: string;
  workspaceLabel?: string;
  isCurrent: boolean;
};

export type ResumeSessionPage = {
  key: string;
  scope: ResumeScope;
  page: number;
  total: number;
  totalPages: number;
  items: ResumeSessionItem[];
};

export function buildModelCard(key: string, models: any[], currentModel: any) {
  const current = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: t("card.current_model.desc", { current }),
    },
  ];

  const rows: any[][] = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2));
  }

  for (const row of rows) {
    elements.push({
      tag: "action",
      actions: row.map((model) => {
        const isCurrent = currentModel?.provider === model.provider && currentModel?.id === model.id;
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${isCurrent ? msg("card.current_prefix") : ""}${model.provider}/${model.id}`,
          },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "pi_feishu_select_model",
            key,
            provider: model.provider,
            modelId: model.id,
          },
        };
      }),
    });
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: msg("card.select_model.title") },
    },
    elements,
  };
}

export function buildResumeCard(data: ResumeSessionPage) {
  const scopeLabel = data.scope === "current" ? msg("card.resume.scope.current") : msg("card.resume.scope.all");
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        t("card.resume.view", { scope: scopeLabel }),
        data.total
          ? t("card.resume.page_info", { page: data.page + 1, totalPages: data.totalPages, total: data.total })
          : msg("card.resume.empty"),
        msg("card.resume.hint"),
      ].join("\n"),
    },
  ];

  elements.push({
    tag: "action",
    actions: [
      buildResumeScopeButton(data.key, "current", data.scope === "current"),
      buildResumeScopeButton(data.key, "all", data.scope === "all"),
    ],
  });

  for (const item of data.items) {
    const lines = [
      `**${escapeMarkdown(item.title)}**${item.isCurrent ? msg("card.resume.current_badge") : ""}`,
      escapeMarkdown(item.subtitle),
      `${msg("card.resume.modified_label")}${escapeMarkdown(item.modifiedLabel)}`,
    ];
    if (item.workspaceLabel) lines.push(`${msg("card.resume.workspace_label")}${escapeMarkdown(item.workspaceLabel)}`);
    elements.push({
      tag: "markdown",
      content: lines.join("\n"),
    });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: item.isCurrent ? msg("card.resume.current_session") : msg("card.resume.switch_to"),
        },
        type: item.isCurrent ? "primary" : "default",
        value: {
          action: "pi_feishu_resume_select",
          key: data.key,
          scope: data.scope,
          page: data.page,
          sessionPath: item.path,
        },
      }],
    });
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: msg("card.resume.prev_page") },
        type: "default",
        disabled: data.page <= 0,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.max(0, data.page - 1),
        },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: msg("card.resume.next_page") },
        type: "default",
        disabled: data.page >= data.totalPages - 1,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
        },
      },
    ],
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: msg("card.resume.title") },
    },
    elements,
  };
}

export function parseModelActionValue(value: unknown): { key: string; provider: string; modelId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_model") return undefined;
  if (typeof raw.key !== "string" || typeof raw.provider !== "string" || typeof raw.modelId !== "string") return undefined;
  return { key: raw.key, provider: raw.provider, modelId: raw.modelId };
}

export function parseResumePageActionValue(value: unknown): { key: string; scope: ResumeScope; page: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_page") return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return { key: raw.key, scope: raw.scope, page: Math.max(0, Math.floor(raw.page)) };
}

export function parseResumeSelectActionValue(value: unknown): { key: string; scope: ResumeScope; page: number; sessionPath: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_select") return undefined;
  if (typeof raw.key !== "string" || typeof raw.sessionPath !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    scope: raw.scope,
    page: Math.max(0, Math.floor(raw.page)),
    sessionPath: raw.sessionPath,
  };
}

function buildResumeScopeButton(key: string, scope: ResumeScope, active: boolean) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: scope === "current" ? msg("card.resume.scope.current") : msg("card.resume.scope.all"),
    },
    type: active ? "primary" : "default",
    value: {
      action: "pi_feishu_resume_page",
      key,
      scope,
      page: 0,
    },
  };
}

function escapeMarkdown(text: string) {
  return text.replace(/[`*_~]/g, "\\$&");
}

function sharedCardConfig() {
  return {
    wide_screen_mode: true,
    update_multi: true,
  };
}
