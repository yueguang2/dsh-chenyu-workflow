/** Chenyu cloud GPU workflow plugin — Host half. */

import { createApi } from './lib/api.mjs'
import { normalizeConfig } from './lib/config.mjs'
import { registerGpuTools } from './lib/gpu-tools.mjs'
import { registerInstanceTools } from './lib/instance-tools.mjs'
import { createQueueManager } from './lib/queue.mjs'
import { registerQueueTools } from './lib/queue-tools.mjs'
import { registerSettingsRoutes } from './lib/settings-routes.mjs'
import { createStateStore } from './lib/state.mjs'
import { registerTools } from './lib/tools.mjs'

export const name = 'chenyu-workflow'
export const inject = ['tools', 'workingDirectory']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const api = createApi({ ctx, getConfig: () => config })
  const state = createStateStore()
  const queue = createQueueManager({ api, config, state })

  registerTools(ctx, { api, config })
  registerGpuTools(ctx, { api, config, state })
  registerInstanceTools(ctx, { api, config, state, queue })
  registerQueueTools(ctx, { api, config, state, queue })

  ctx.effect(() => {
    void queue.start().catch((error) => console.error('[chenyu-workflow] 队列读取失败：', error?.message ?? error))
    return () => queue.stop()
  }, 'chenyu-workflow: durable queue')

  ctx.inject(['webServer', 'connection', 'sessionController', 'workingDirectory'], (child) => {
    registerSettingsRoutes(child, { api, config, state, queue })
  })
}
