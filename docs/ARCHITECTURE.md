# 架构说明

晨羽智云工作流插件是一个 DeepSeek Harness（DSH）bundle，由两部分组成：

- **Host 端**（`index.js` + `lib/`）：注册模型工具、设置/任务 HTTP 路由，并运行持久化任务队列。
- **Web 客户端**（`client.js`）：在设置页和会话输入区注册 React 面板，通过 `/api/chenyu-workflow` 调用 Host。

```
┌──────────────────────────── Web 客户端 (client.js) ────────────────────────────┐
│  设置 →「晨羽智云」       会话输入区：启动器 / 任务面板 / 任务历史              │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ fetch /api/chenyu-workflow/*
┌───────────────────────────────────▼────────────────────────────────────────────┐
│ Host 端                                                                        │
│  settings-routes.mjs ──► submit.mjs ──► queue.mjs ──► runner.mjs ──► comfy.mjs   │
│         │                    │              │             │                     │
│         │                    │              │             └─► workspace.mjs     │
│         │                    │              └─► instance-ops.mjs / pod-update.mjs│
│         │                    └─► job-spec.mjs / defaults.mjs                    │
│         └─► api.mjs / gpu.mjs / workflow-catalog.mjs / state.mjs                 │
│                                                                                │
│  tools.mjs / instance-tools.mjs / gpu-tools.mjs / queue-tools.mjs ──► 模型工具  │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 模块

| 模块 | 职责 |
| --- | --- |
| `index.js` | 插件入口：注入 `tools` 等服务，注册模型工具与 HTTP 路由，启动队列。 |
| `lib/api.mjs` | 晨羽 Open API 客户端：鉴权、超时、统一错误（`ChenyuApiError`）。 |
| `lib/config.mjs` | 配置默认值与归一化（API Key 引用、默认实例、默认显卡、自动关机）。 |
| `lib/constants.mjs` | 共享常量（任务状态、事件名、超时与轮询参数）。 |
| `lib/error-messages.mjs` | 常见错误的友好文案映射与瞬时错误判定（供重试逻辑使用）。 |
| `lib/defaults.mjs` | 内置工作流族（MOSS 文生图、MiniMax H3 图生视频）与类型推断。 |
| `lib/gpu.mjs` / `lib/gpu-tools.mjs` | 显卡目录：列出、按名称/UUID 匹配、保存图片/视频默认显卡。 |
| `lib/instance-ops.mjs` | 实例生命周期：查询、开机等待、关机并确认。 |
| `lib/instance-tools.mjs` | 实例与工作流目录相关模型工具（`chenyu_instance_*`）。 |
| `lib/job-spec.mjs` | 把模型/UI 参数归一化为一个可持久化的任务规格。 |
| `lib/submit.mjs` | Web UI 与模型工具共用的提交校验。 |
| `lib/queue.mjs` | 持久化串行队列：入队、恢复、取消、重试、关机回执。 |
| `lib/queue-tools.mjs` | 队列控制工具与快捷生成工具（`chenyu_queue_*`、`chenyu_image_generate`、`chenyu_video_generate`）。 |
| `lib/runner.mjs` | 执行单个任务：准备工作流、调用 ComfyUI、轮询进度、下载产物。 |
| `lib/comfy.mjs` | ComfyUI 客户端与 UI 工作流 → API prompt 转换。 |
| `lib/workflow-adapt.mjs` | 按实例当前节点 schema 适配工作流（重映射节点、校验必填输入）。 |
| `lib/workflow-catalog.mjs` | 读取实例内真实存在的 `workflows` 目录，并按实例/镜像版本缓存。 |
| `lib/pod-update.mjs` | 读取 Pod 最新版本，按新版本创建实例。 |
| `lib/settings-routes.mjs` | `/api/chenyu-workflow` 路由：设置、库、目录、任务提交与下载。 |
| `lib/state.mjs` | 插件状态文件读写（原子写入）。 |
| `lib/workspace.mjs` | 工作目录与输出文件路径处理。 |
| `lib/media.mjs` | 素材与产物的文件辅助函数。 |

## 数据流

1. **提交**：Web 面板或模型工具调用 `submit.mjs` → `job-spec.mjs` 生成任务规格 → `queue.mjs` 入队（带 `request_id` 幂等键，重试不会重复计费）。
2. **执行**：队列串行取出任务 → `instance-ops.mjs` 复用/创建实例并等待 ComfyUI 就绪 → `workflow-adapt.mjs` 准备图 → `comfy.mjs` 提交 prompt → `runner.mjs` 轮询进度并下载产物到 `workspace.mjs` 解析出的目录。
3. **关机**：队列不再需要该实例时，`instance-ops.mjs` 发起关机并等待晨羽确认，结果写入任务 `shutdown` 回执。提交前已在运行、由用户维护的实例保持原状。
4. **恢复**：队列文件位于 `~/.dsh/chenyu-workflow/`，插件重载后恢复待执行任务，并把中断的任务标记为失败。

## 队列策略

- 全局串行：同一时间只运行一个工作流或目录扫描任务。
- 相邻任务若指向同一实例（或同一 Pod 版本）则复用，不重复开机。
- 关机只在「队列自己开过机」时发起；`auto_shutdown` 关闭时保留实例。
- 取消：排队中的任务直接移除；运行中的任务标记 `cancel_requested`，由执行器在安全检查点结束。

## Web 客户端

`client.js` 通过 `window.__ModuleLoader__` 注册一个懒工厂，向三个槽位注册界面：

| 槽位 | 内容 |
| --- | --- |
| `settings.section` | 「晨羽智云」设置页：API Key、默认实例、默认显卡、Pod 库、Pod 更新。 |
| `conversation.input.left` | 输入框左侧的「晨羽智云」启动按钮。 |
| `conversation.input.dock` | 会话输入区下方的工作流面板与任务历史。 |

客户端行为：

- **草稿自动保存**：提示词与高级参数按会话写入 `localStorage`（7 天过期），刷新或重新打开面板后恢复。
- **自适应轮询**：有活跃任务时 1.7 秒轮询；空闲后逐步降频，最长 10 秒一次。
- **任务通知**：任务成功/失败/取消时发送桌面通知（需用户授权，在首次提交时请求）。
- **错误提示**：网络、超时、鉴权、余额、显卡等常见错误转为可读文案，其余保留原文。

## 配置与存储

| 内容 | 位置 |
| --- | --- |
| API Key | DSH 凭据服务（键名见 `lib/config.mjs` 的 `apiKeyRef`），或 `CHENYU_API_KEY` 环境变量 |
| 插件设置 | DSH 配置存储（默认实例、默认显卡、自动关机、Pod 库） |
| 任务队列 | `~/.dsh/chenyu-workflow/queue.json`（原子写入） |
| 工作流目录缓存 | `~/.dsh/chenyu-workflow/` 下的目录缓存文件 |
| 生成结果 | 会话工作目录 `generated/chenyu/instance/<实例UUID>/<时间>` |

## 测试

- `test/queue.test.mjs`、`test/workflow-adapt.test.mjs`：Node 内置测试运行器（`node --test`），覆盖队列生命周期、恢复、工作流适配与执行器。
- `test/constants.test.mjs`、`test/error-messages.test.mjs`：Vitest 单元测试。
- `npm test` 依次运行两套测试；`npm run test:coverage` 生成覆盖率报告。

## 已知限制

- 同一时间只运行一个任务；需要并发时请分多个会话并按需扩展队列策略。
- 工作流目录扫描会计费（需要开机读取镜像目录），普通刷新只读缓存。
- 工作流适配依赖实例当前的 `/object_info`；自定义节点缺失时会给出明确报错而不是静默失败。
