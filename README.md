# 晨羽智云工作流 · dsh-chenyu-workflow

[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB)](https://github.com/yueguang2/dsh-chenyu-workflow)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2-0B5FFF)](https://github.com/yueguang2/dsh-chenyu-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)](package.json)

DeepSeek Harness（DSH）插件：从晨羽智云云端 Pod 镜像选择一个确切版本和其中的 ComfyUI 工作流。提交后，插件按需创建或复用实例、选择显卡开机、执行工作流，把结果下载到会话工作目录，并在队列不再需要算力时关闭它负责的实例。

> A DeepSeek Harness (DSH) plugin for running Chenyu cloud ComfyUI workflows: pick a Pod version and workflow, start a GPU on demand, run jobs serially, download results, and shut the instance down automatically.

## 功能

- **按版本运行工作流**：从已保存的 Pod 库选择镜像版本，读取该版本 `workflows` 目录中的 ComfyUI 工作流（支持 UI 格式与 API prompt 格式）。
- **按需 GPU**：图片、视频可分别设置默认显卡；提交时显示平台费率与可用状态，任务结束自动关机。
- **持久化串行队列**：任务写入 `~/.dsh/chenyu-workflow/`，插件重载后恢复；相邻任务复用同一实例，避免重复开机。
- **会话内进度**：当前会话可查看进度、历史、输出文件与关机回执；其他会话保留入口。
- **对话工具**：`chenyu_instance_*`、`chenyu_queue_*`、`chenyu_workflow_*` 等工具可直接在对话中调用。
- **界面细节**：草稿自动保存（刷新不丢失）、任务完成桌面通知、自适应轮询（空闲时自动降频）、友好的中文错误提示。

## 安装

需要 DeepSeek Harness 桌面端（自带插件管理器）。

```bash
git clone https://github.com/yueguang2/dsh-chenyu-workflow.git
```

1. 打开 DSH，进入 **设置 → 插件**（Plugins）。
2. 点击 **添加插件**（Add plugin），选择刚克隆的仓库目录。
3. 在插件列表启用 **晨羽智云工作流**，新开一个会话生效。

也可以把本地目录直接交给支持 `plugin_manager` 的会话安装（`install_bundle` 的 `target` 传仓库绝对路径）。

## 配置

在 **设置 → 晨羽智云** 保存 API Key。也可以用启动 DSH 时的 `CHENYU_API_KEY` 环境变量。设置页支持测试连接和查询余额。[晨羽 API 管理](https://www.chenyu.cn/console/apiServer)

- 在 **已保存的 Pod 库** 添加云端 Pod UUID。插件首次打开库时会从已有实例导入关联镜像。可添加多个 Pod，例如 `1166fbd2cbe44b7f9c58dc5dfa834e7c`（YZ金鱼-专属ComfyUI镜像-精选工作流）。
- 分别保存图片和视频的默认显卡。每次提交都可以覆盖默认值，显卡列表会显示平台费率和可用状态。
- 按需保存 **默认现有实例**。对话工具未指定 Pod 或实例时使用该实例。

## 从会话运行

1. 在输入框旁打开 **晨羽智云**，选择一个已保存的 Pod 及其确切版本，或选择现有实例。
2. 选择该镜像 `workflows` 目录中的文件。运行中的实例提供实时目录，读取过的版本可从缓存选取。首次使用时，可以输入准确文件名或相对路径，也可以选好显卡后确认一次付费扫描。普通刷新目录只读已有数据。
3. 确认显卡、填入提示词并提交。可选设置支持种子、画面比例、分辨率、时长、工作目录中的参考文件和按节点 ID 指定的覆盖参数。
4. 在提交任务的会话查看进度、历史、输出文件和关机回执。其他会话保留发起任务的短入口。可在任务列表取消或重试。

工作流和目录扫描共用一个持久化串行队列。相邻任务需要同一台已开机实例时会复用它。队列不再需要该算力时发送关机请求并等晨羽确认，默认立即发起。提交前已经运行、由你在晨羽控制台维护的实例保留原有开机状态。

结果默认保存到会话工作目录的 `generated/chenyu/instance/<实例UUID>/<时间>`。插件重新加载时会恢复待执行任务，记录中断的任务，并先处理先前由队列负责的实例。

## 在对话里指定工作流

先用 `chenyu_instance_list` 查看保存的 Pod、可选版本和已有实例，再用 `chenyu_instance_workflows` 读取所选版本的工作流目录。传 `start_if_needed: true` 允许付费开机读取。`chenyu_instance_workflow_inspect` 可以进一步读取工作流的实际节点 ID 和输入名。

向 `chenyu_instance_workflow_run` 传入确切版本和工作流即可。例如：

```json
{
  "pod_uuid": "1166fbd2cbe44b7f9c58dc5dfa834e7c",
  "pod_tag": "V1.0.0",
  "workflow_name": "YZ金鱼-MOSS-文生图.json",
  "gpu": "RTX 4080",
  "prompt": "傍晚的山间小站，窗内透出暖光"
}
```

也可以用 `instance_uuid` 选择实例，或通过 `workflow_file` 指定本地文件、`workflow_json` 提交对象。若自定义节点的参数需要明确指定，可传 `prompt_node`、`prompt_input`、`overrides` 或 `files`。

`chenyu_image_generate` 和 `chenyu_video_generate` 分别使用 MOSS 和 MiniMax H3 快捷工作流。两个工具均支持选择 Pod 版本和单次显卡。队列工具 `chenyu_queue_status`、`chenyu_queue_wait`、`chenyu_queue_cancel`、`chenyu_queue_clear`、`chenyu_queue_retry` 都按调用所在的会话操作。

## 检查 Pod 更新

在设置的 **实例的 Pod 镜像版本** 选择实例并检查更新，或调用 `chenyu_pod_update_check`。检查会显示该实例的 `image_tag` 和所属 Pod 最新发布版本。

有新版本时，可以确认 **通过新实例使用新版**。插件创建或复用该确切版本的实例并保留原实例。原实例是默认实例时才会更新默认值。也可以直接在会话按版本选择新 Pod，首次执行时按需准备实例。

## 工作流市场

平台工作流市场仍可通过 `chenyu_workflow_list`、`chenyu_workflow_info`、`chenyu_workflow_run`、`chenyu_workflow_wait` 和 `chenyu_workflow_download` 使用。提交前读取报价和 `parameters`。本地素材可通过 `chenyu_workflow_upload` 换取 `asset_uri`，实际费用以晨羽结算为准。[晨羽接口文档](https://enterprise.chenyu.cn/userguide/introduction)

## 开发与测试

```bash
npm install
npm test              # Node 内置测试（队列 / 工作流适配）+ Vitest 单元测试
npm run test:unit     # 只跑 Vitest 单元测试
npm run test:coverage # 覆盖率报告
```

目录结构：

```
index.js            # 插件入口：注册工具、设置路由与队列
client.js           # Web 客户端：设置页与会话输入区面板
lib/                # API 客户端、队列、执行器、工作流适配等
locale/             # 中英文界面文案
docs/               # 架构说明
```

模块与数据流说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)
