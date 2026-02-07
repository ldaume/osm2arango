import type { FetchLike } from '../util/fetch.ts'
import { mkdir } from 'node:fs/promises'

export interface DownloadOptions {
  baseUrl: string
  outDir: string
}

export interface DownloadResult {
  url: string
  path: string
}

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes?: number
}

export interface DownloadDeps {
  fetch?: FetchLike
  onProgress?: (progress: DownloadProgress) => void
  now?: () => number
  progressIntervalMs?: number
}

export async function downloadGeofabrikExtract(
  regionOrUrl: string,
  opts: DownloadOptions,
  deps?: DownloadDeps,
): Promise<DownloadResult> {
  const url = resolveGeofabrikUrl(regionOrUrl, opts.baseUrl)
  const fileName = url.split('/').pop() ?? 'extract.osm.pbf'
  const path = `${opts.outDir.replace(/\/+$/, '')}/${fileName}`

  await mkdir(opts.outDir, { recursive: true })

  const fetchFn = deps?.fetch ?? fetch
  const res = await fetchFn(url)
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`)
  }

  const totalBytes = parseContentLength(res.headers.get('content-length'))
  const now = deps?.now ?? Date.now
  const progressIntervalMs = deps?.progressIntervalMs ?? 500
  let lastProgressAt = 0
  let downloadedBytes = 0

  const reportProgress = (force: boolean): void => {
    if (!deps?.onProgress)
      return
    const t = now()
    if (!force && t - lastProgressAt < progressIntervalMs)
      return
    lastProgressAt = t
    deps.onProgress(totalBytes === undefined ? { downloadedBytes } : { downloadedBytes, totalBytes })
  }

  if (!res.body) {
    await Bun.write(path, res)
    downloadedBytes = res.headers.has('content-length') ? (totalBytes ?? 0) : 0
    reportProgress(true)
    return { url, path }
  }

  const sink = Bun.file(path).writer({ highWaterMark: 1024 * 1024 })
  try {
    for await (const chunk of res.body) {
      downloadedBytes += chunk.byteLength
      const wrote = sink.write(chunk)
      if (wrote instanceof Promise)
        await wrote
      reportProgress(false)
    }

    const ended = sink.end()
    if (ended instanceof Promise)
      await ended
  }
  catch (err) {
    try {
      const e = err instanceof Error ? err : new Error(String(err))
      const ended = sink.end(e)
      if (ended instanceof Promise)
        await ended
    }
    catch {}
    throw err
  }

  reportProgress(true)
  return { url, path }
}

export function resolveGeofabrikUrl(input: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(input))
    return input

  const cleaned = input.replace(/^\/+/, '').replace(/\/+$/, '')
  const isPbf = cleaned.endsWith('.osm.pbf')
  const withFile = isPbf ? cleaned : `${cleaned}-latest.osm.pbf`

  return `${baseUrl.replace(/\/+$/, '')}/${withFile}`
}

function parseContentLength(value: string | null): number | undefined {
  if (!value)
    return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0)
    return undefined
  return n
}
