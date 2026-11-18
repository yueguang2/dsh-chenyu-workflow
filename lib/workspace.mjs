import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function within(root, path, { allowRoot = false } = {}) {
  const suffix = relative(root, path)
  return (allowRoot || Boolean(suffix)) && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

export async function workspaceFile(root, value, label) {
  const path = await realpath(resolve(root, value))
  if (!within(root, path) || !(await stat(path)).isFile()) throw new Error(`${label} 必须指向会话工作目录中的文件。`)
  return path
}

/** Pin a directory to its actual in-workspace parent even if it has yet to be created. */
export async function workspaceDirectory(root, value) {
  const path = resolve(root, value)
  if (!within(root, path, { allowRoot: true })) throw new Error('输出目录不在会话工作目录中。')
  let candidate = path
  for (;;) {
    try {
      const actual = await realpath(candidate)
      if (!within(root, actual, { allowRoot: true }) || !(await stat(actual)).isDirectory()) throw new Error('输出目录不在会话工作目录中。')
      return resolve(actual, relative(candidate, path))
    } catch (error) {
      if (error.code !== 'ENOENT' || candidate === root) throw error
      candidate = dirname(candidate)
    }
  }
}
