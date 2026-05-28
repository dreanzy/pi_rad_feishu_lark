export function modelLabel(model: any) {
  if (!model) return "未选择";
  return `${model.provider}/${model.id}`;
}

export function buildModelCard(key: string, models: any[], currentModel: any) {
  const current = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: `当前模型：**${current}**\n点击下面的按钮即可切换当前飞书会话使用的模型。`,
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
            content: `${isCurrent ? "当前 " : ""}${model.provider}/${model.id}`,
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
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择 Pi 模型" },
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
