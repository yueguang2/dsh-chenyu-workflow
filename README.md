# 晨羽智云工作流

从晨羽云端 Pod 镜像选择一个确切版本和其中的 ComfyUI 工作流。提交后，插件按需创建或复用实例，选择显卡开机，执行工作流，把结果下载到会话工作目录，并关闭队列负责的实例。

## 配置

在 **设置 → 晨羽智云** 保存 API Key。也可以用启动 DSH 时的 `CHENYU_API_KEY` 环境变量。设置页支持测试连接和查询余额。 [晨羽 API 管理](https://www.chenyu.cn/console/apiServer)

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

也可以用 `instance_uuid` 选择实例，或通过 `workflow_file` 指定本地文件、`workflow_json` 提交对象。工作流支持 ComfyUI UI 格式和 API prompt 格式。若自定义节点的参数需要明确指定，可传 `prompt_node`、`prompt_input`、`overrides` 或 `files`。

`chenyu_image_generate` 和 `chenyu_video_generate` 分别使用 MOSS 和 MiniMax H3 快捷工作流。两个工具均支持选择 Pod 版本和单次显卡。队列工具 `chenyu_queue_status`、`chenyu_queue_wait`、`chenyu_queue_cancel`、`chenyu_queue_clear`、`chenyu_queue_retry` 都按调用所在的会话操作。

## 检查 Pod 更新

在设置的 **实例的 Pod 镜像版本** 选择实例并检查更新，或调用 `chenyu_pod_update_check`。检查会显示该实例的 `image_tag` 和所属 Pod 最新发布版本。

有新版本时，可以确认 **通过新实例使用新版**。插件创建或复用该确切版本的实例并保留原实例。原实例是默认实例时才会更新默认值。也可以直接在会话按版本选择新 Pod，首次执行时按需准备实例。

## 工作流市场

平台工作流市场仍可通过 `chenyu_workflow_list`、`chenyu_workflow_info`、`chenyu_workflow_run`、`chenyu_workflow_wait` 和 `chenyu_workflow_download` 使用。提交前读取报价和 `parameters`。本地素材可通过 `chenyu_workflow_upload` 换取 `asset_uri`，实际费用以晨羽结算为准。 [晨羽接口文档](https://enterprise.chenyu.cn/userguide/introduction)
