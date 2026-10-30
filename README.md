# DSH Computer Use

面向 DeepSeek Harness 的浏览器工具与实验性 macOS 桌面控制插件。当前版本：**0.12.0-alpha.1**。

Browser automation and an experimental macOS computer-use adapter for DeepSeek Harness. The existing DSH agent provides the model and planning loop; this plugin supplies observations and actions.

## 功能

- 浏览器：独立 Playwright Chromium Headless Shell、语义树与控件引用、多标签页、真实网页截图、受约束的坐标点击和文件上传。网站来源需要配置或批准；默认只允许本机练习台。
- macOS 桌面：复用或打开应用、选定真实窗口截图、纯截图模式下的坐标点击、中文及 emoji 输入、快捷键，以及独立 AX 模式。
- 任务授权：对指定进程和窗口批准有限时长的任务；常规截图及输入共用范围授权。原生预览、置顶授权小窗、撤销、到期和取消处理。
- 减少往返：`cu_desktop_start` 合并任务准备与首图；`cu_desktop_step` 合并单个输入与事后截图。支持精确图片引用复用及 Native 桌面历史图片批量卸载/回查。

这是预览版。浏览器、桌面、图片历史的覆盖范围各不相同；[已知限制](docs/KNOWN-LIMITATIONS.md)和[验证范围](docs/VALIDATION.md)是发布内容的一部分。未证明模型自主任务的通用成功率或 API 费用下降。

## 安装浏览器插件

需要 Node.js ≥22.19.0 和提供 tools/attachments 服务的 DSH。安装到实际使用的 profile；桌面 App 通常为 `desktop`。

在 DSH 的第三方插件安装入口填入：

```text
github:Mersolceil/dsh-computer-use#v0.12.0-alpha.1
```

或使用 CLI：

```sh
dsh plugin --profile desktop add 'github:Mersolceil/dsh-computer-use#v0.12.0-alpha.1'
```

本项目未发布到 npm；不要用同名 npm 包替代上述来源。首次使用需安装匹配的独立浏览器运行时：

```sh
npx --yes --package=playwright@1.63.0 playwright install chromium-headless-shell
```

默认不会使用个人 Chrome 的登录资料。网站来源、上传目录与运行时说明见[中文指南](docs/PLUGIN-GUIDE.zh.md)及[English guide](docs/PLUGIN-GUIDE.en.md)。插件不会绕过网站登录、验证码或内容保护。

## 启用 macOS 桌面功能

**市场安装默认挂载浏览器组件；桌面功能需额外构建助手和配置组件。** 真实截图/视觉输入需要 macOS 14+、Swift/Xcode Command Line Tools，以及使用者明确授予的系统权限。构建的助手为本地 ad-hoc 签名，未公证，不附带预先授权的二进制。

参照[桌面配置指南](docs/DESKTOP-CONTROL.md)完成构建、配置和授权后，让 DSH 优先使用：

```text
cu_desktop_start({application: "Obsidian", purpose: "在新笔记输入用户指定文字", control: true})
cu_desktop_step({action: "type", screenshot_id: "上一张图的真实ID", text: "用户指定的文字"})
cu_desktop_revoke({})
```

中间的打开新文档、选择输入位置及保存也要根据实际截图执行。示例不是可盲目重放的坐标脚本。敏感操作仍需单独批准；纯像素不能可靠识别所有敏感按钮。详见[0.12 操作与图片历史](docs/DESKTOP-WORKFLOW-0.12.md)。

## 验证

优先只运行改动相关的本地检查，例如：

```sh
npm ci --ignore-scripts
node --test test/desktop-workflow.test.js test/desktop-images.test.js test/desktop-approval.test.js
```

原生/DSH集成脚本的前置条件见验证文档。**默认不需要付费模型测试**；`eval:dsh`、带真实模型标志的脚本会消耗 API 额度，应先自行设定明确调用和费用上限。已有验证证据不能替代对新平台或个人应用的验收。

## License

MIT。由 AI 辅助开发。第三方依赖保留其各自许可证。
