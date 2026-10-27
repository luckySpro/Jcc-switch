# 决策记录（只追加）

1. **上游导入**：上游完整 git 历史推入 luckySpro/Jcc-switch 的 main，保留 `upstream` 远程定期合并。（2026-10-27，Micky 确认）
2. **探测隐私**：Key 只发往规则表里候选供应商的官方域名，界面在探测前列出域名，可关闭自动探测。（同上）
3. **数据目录**：使用 `~/.jcc-switch`，首次启动若不存在则从 `~/.cc-switch` 复制数据库与设置；Bundle ID 改为 `com.mjgroup.jccswitch`，可与上游并存。（同上）
4. **前端**：沿用上游 React + TypeScript + Tailwind + shadcn，不换 Vue。（同上）
5. **首版范围**：Claude Code、Codex、Gemini CLI。（同上）
6. **粘贴带地址**：内容里有 http(s) 地址时按该地址走兼容接口；主机属于已知供应商则套用该供应商规则。（2026-10-27，Micky 补充）
7. **写入方式**：识别在 Rust，写入在前端套用上游预设后调用原有 `add_provider` / `switch_provider`，不另写配置文件。
8. **深链接**：保留 `ccswitch://` 方案，供应商网站上的一键导入链接继续可用；与上游同时安装时由系统决定打开哪一个。
9. **更新**：更新源改为本仓库 Release；在配置自己的签名密钥前关闭 `createUpdaterArtifacts`。
