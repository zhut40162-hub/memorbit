# GitHub公开副本整理记录

整理日期：2026-10-26。来源为用户提供的部署压缩包，不重构或补造开发历史。

新增：README、.gitignore、零依赖本地预览脚本、package.json、实际页面截图和本记录。

原有应用文件变更：app.js, index.html, release-manifest.json。

## 星迹的公开化调整

- `app.js`：移除默认生产服务地址，改从 `config.js` 读取；未配置时在请求前提示并停止。
- `index.html`：在应用启动前加载配置文件；未调整界面、样式或流程文案。
- `config.js`：新增空接口配置，禁止在前端放模型提供方密钥。
- `release-manifest.json`：标注当前为公开前端快照；原清单原样保存在 `docs/source-release-manifest.json`。
- 原清单引用的测试报告未包含在用户提供的压缩包中，因此不能据其“passed”字段声称已重新验证全部功能。

## 本次核验范围

发布前执行文本型密钥模式扫描、JavaScript语法检查、HTML本地资源路径检查与本地首页加载；不调用线上AI服务，不使用真实用户资料。不把这些检查称为完整产品测试或模型效果评测。
