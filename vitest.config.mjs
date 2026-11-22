/** Vitest configuration for unit tests. */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `test/queue.test.mjs` and `test/workflow-adapt.test.mjs` use the Node.js
    // built-in test runner (`node --test`); keep them out of Vitest so both
    // suites can coexist under `npm test`.
    include: ['test/**/*.test.mjs'],
    exclude: ['**/node_modules/**', 'test/queue.test.mjs', 'test/workflow-adapt.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.mjs'],
      exclude: [
        'lib/comfy.mjs', // Integration with ComfyUI
        'lib/api.mjs', // External API calls
      ],
    },
  },
})
