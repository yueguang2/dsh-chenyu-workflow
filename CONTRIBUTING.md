# 贡献指南

感谢你对晨羽智云工作流插件的贡献兴趣！

## 开发环境搭建

### 前置要求

- Node.js >= 18
- DeepSeek Harness 最新版本
- 晨羽智云 API Key

### 安装依赖

```bash
git clone https://github.com/yueguang2/dsh-chenyu-workflow.git
cd dsh-chenyu-workflow
npm install
```

### 运行测试

```bash
# 运行所有单元测试
npm test

# 监听模式（开发时推荐）
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

### 本地开发

1. 在 DSH 中加载插件：
   - 将插件目录链接到 DSH 插件目录
   - 或在 DSH 设置中添加本地插件路径

2. 修改代码后重载插件：
   - 重启 DSH
   - 或使用热重载（如果可用）

## 代码规范

### JavaScript 风格

- 使用 ES6+ 模块语法 (.mjs)
- 函数优先使用 async/await
- 错误处理使用 try-catch
- 避免 var，使用 const/let

**示例：**
```javascript
// ✅ 推荐
export async function fetchData(url) {
  try {
    const response = await fetch(url)
    return await response.json()
  } catch (error) {
    throw new Error(`Failed to fetch: ${error.message}`)
  }
}

// ❌ 不推荐
export function fetchData(url, callback) {
  fetch(url).then(r => r.json()).then(callback).catch(err => console.log(err))
}
```

### 命名规范

- 文件名：kebab-case (error-messages.mjs)
- 函数名：camelCase (validateNumber)
- 常量：UPPER_SNAKE_CASE (DEFAULT_CONFIG)
- React 组件：PascalCase (WorkflowPanel)
- 私有函数：_camelCase (内部使用)

### 注释规范

使用 JSDoc 注释导出函数：

```javascript
/**
 * Validate numeric input within range
 * @param {string} value - Input value
 * @param {string} fieldName - Field name for error messages
 * @param {object} options - Validation options
 * @param {number} [options.min=-Infinity] - Minimum value
 * @param {number} [options.max=Infinity] - Maximum value
 * @param {boolean} [options.integer=false] - Must be integer
 * @returns {number|null} Parsed number or null for empty input
 * @throws {Error} If validation fails
 */
export function validateNumber(value, fieldName, options = {}) {
  // 实现...
}
```

## 提交规范

### Commit 消息格式

使用约定式提交（Conventional Commits）：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**类型 (type):**
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构（不修复 bug，不添加功能）
- `perf`: 性能优化
- `test`: 添加或修改测试
- `chore`: 构建过程或辅助工具变动

**作用域 (scope):**
- `queue`: 队列管理
- `runner`: 工作流执行
- `ui`: 用户界面
- `api`: API 客户端
- `validation`: 输入验证
- `notification`: 通知系统

**示例：**
```
feat(validation): add JSON depth limit validation

- Add maxDepth option to validateJsonObject
- Prevent deeply nested object attacks
- Add unit tests for depth validation

Closes #123
```

## 测试要求

### 新功能必须包含测试

为所有新函数编写单元测试：

```javascript
// lib/my-feature.mjs
export function myFeature(input) {
  return input * 2
}

// test/my-feature.test.mjs
import { describe, it, expect } from 'vitest'
import { myFeature } from '../lib/my-feature.mjs'

describe('myFeature', () => {
  it('should double the input', () => {
    expect(myFeature(5)).toBe(10)
  })
  
  it('should handle zero', () => {
    expect(myFeature(0)).toBe(0)
  })
})
```

### 测试覆盖率要求

- 新增代码覆盖率 >= 80%
- 关键路径覆盖率 >= 90%
- 边界情况必须测试

### 运行测试

提交前运行完整测试套件：

```bash
npm test
npm run test:coverage
```

## 国际化 (i18n)

### 添加新文本

1. 在 `locale/zh.json` 添加中文文本
2. 在 `locale/en.json` 添加英文翻译
3. 使用 `t()` 函数引用

**示例：**
```json
// locale/zh.json
{
  "ui": {
    "newFeature": "新功能说明"
  }
}

// locale/en.json
{
  "ui": {
    "newFeature": "New feature description"
  }
}
```

```javascript
// 在代码中使用
const text = t('newFeature')
```

## Pull Request 流程

### 1. Fork 仓库

（如果是外部贡献者）

### 2. 创建特性分支

```bash
git checkout -b feat/my-feature
```

### 3. 实现功能

- 遵循代码规范
- 编写测试
- 更新文档

### 4. 提交代码

```bash
git add .
git commit -m "feat(scope): description"
```

### 5. 推送分支

```bash
git push origin feat/my-feature
```

### 6. 创建 Pull Request

- 填写 PR 模板
- 关联相关 issue
- 通过所有 CI 检查

### PR 审查清单

- [ ] 代码遵循项目规范
- [ ] 包含必要的测试
- [ ] 测试全部通过
- [ ] 更新了相关文档
- [ ] 无合并冲突
- [ ] Commit 消息清晰

## 常见开发任务

### 添加新的验证规则

1. 在 `lib/job-spec.mjs`（任务规格）或 `lib/submit.mjs`（提交入口）添加校验
2. 在 `test/workflow-adapt.test.mjs` 或对应的 Vitest 测试中添加用例
3. 在 `locale/` 中补充错误文案（如面向用户）

### 添加新的错误类型

1. 在 `lib/error-messages.mjs` 添加错误模式
2. 在 `locale/` 添加错误消息翻译
3. 添加测试用例

### 添加新的 UI 组件

1. 在 `client.js` 中实现组件（单文件浏览器模块）
2. 复用现有的 `Button`、`field`、`note`、`notice`、`pill` 辅助函数
3. 在 `CSS` 中补充样式并验证明暗主题

### 优化性能

1. 使用 Chrome DevTools 性能分析
2. 识别瓶颈
3. 实施优化
4. 验证改进（附带性能数据）

## 调试技巧

### 服务端调试

```javascript
// 添加调试日志
console.log('[chenyu-workflow]', 'Debug info:', data)
console.error('[chenyu-workflow]', 'Error:', error)
```

### 客户端调试

```javascript
// 浏览器控制台
window.__chenyuDebug = true

// 查看队列状态
fetch('/api/chenyu-workflow/jobs?session_id=xxx')
  .then(r => r.json())
  .then(console.log)
```

### 查看持久化文件

```bash
# 状态文件
cat ~/.dsh/chenyu-workflow/state.json

# 队列文件
cat ~/.dsh/chenyu-workflow/queue.json
```

## 文档更新

修改功能时请同步更新：

- `README.md` - 用户文档
- `docs/ARCHITECTURE.md` - 架构文档
- `CHANGELOG.md` - 变更日志

## 发布流程

（仅维护者）

1. 更新版本号（`package.json`）
2. 更新 `CHANGELOG.md`
3. 创建 git tag
4. 推送 tag 触发发布

## 获取帮助

- 查看现有 issues
- 创建新 issue 描述问题
- 在 PR 中 @ 维护者

## 行为准则

- 尊重他人
- 建设性反馈
- 专注技术讨论
- 欢迎新手提问

---

再次感谢你的贡献！🎉
