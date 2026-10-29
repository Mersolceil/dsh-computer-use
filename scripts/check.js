import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
for (const dir of ['src', 'eval', 'test', 'scripts']) {
  for (const entry of await readdir(dir)) if (/\.(js|cjs)$/.test(entry)) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${entry}`], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status || 1)
  }
}
console.log('JavaScript syntax: OK')
