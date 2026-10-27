# Jcc-switch v1 规划：一键贴 Key

完整规划文档：https://claude.ai/artifact/7ZtQHiYCrXfoABPxR2Kxg3
界面原型：https://claude.ai/artifact/7T8S7bpt6be6UmEvimAVYU

## 目标

用户粘贴一个 Key（或一段带地址的配置），Jcc-switch 认出供应商、拉取并分配模型，
写进 Claude Code / Codex / Gemini CLI，3 步以内完成。

## 验收链路

1. 粘贴 → 预览：显示屏蔽后的 Key 和将要访问的官方域名（不联网）。
2. 识别：并发请求候选供应商的模型列表接口，200 命中，401/403 排除。
3. 确认：按应用勾选，自动分配的模型可改。
4. 保存并启用：沿用上游「添加 + 启用」，写入对应配置文件。

粘贴内容里带 http(s) 地址时，以该地址为准，按兼容接口拉模型、写配置。

## 分阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 导入上游历史，改产品身份、数据目录、更新源 | 完成 |
| P1 | Rust 识别引擎 `src-tauri/src/quick_add/` | 完成 |
| P2 | 粘贴界面 `src/components/quick-add/` | 完成 |
| P3 | 写入三个应用，复用上游保存/启用 | 完成 |
| P4 | 五张色卡、截图（识别规则设置页待做） | 部分完成 |
| P5 | 安装包、强制升级、GitHub Release | 未开始，需配置签名密钥 |
