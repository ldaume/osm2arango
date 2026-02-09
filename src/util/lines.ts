export interface TooLongLineInfo {
  bytes: number
  maxLineBytes: number
}

export interface ReadLinesOptions {
  maxLineBytes?: number
  tooLongLine?: 'skip' | 'error'
  onTooLongLine?: (info: TooLongLineInfo) => void
  /**
   * Whether to yield a final line without a trailing newline when the stream ends.
   *
   * - NDJSON files often omit the trailing newline => keep this `true` (default).
   * - Subprocess stdout can end mid-record if the process crashes or gets killed => set `false`
   *   to avoid yielding a truncated "line" that will never parse as JSON.
   */
  flushFinalPartialLine?: boolean
  onFinalPartialLine?: (info: { bytes: number }) => void
}

export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  opts?: ReadLinesOptions,
): AsyncGenerator<string> {
  const maxLineBytes = opts?.maxLineBytes
  const tooLongLine = opts?.tooLongLine ?? 'error'
  const flushFinalPartialLine = opts?.flushFinalPartialLine ?? true

  if (maxLineBytes !== undefined && (!Number.isFinite(maxLineBytes) || maxLineBytes <= 0)) {
    throw new Error(`Invalid maxLineBytes: ${String(maxLineBytes)}`)
  }

  const decoder = new TextDecoder()

  let parts: Uint8Array[] = []
  let partsBytes = 0

  let dropping = false
  let droppedBytes = 0

  const finishDroppedLine = (): void => {
    if (!dropping)
      return
    dropping = false
    if (maxLineBytes !== undefined) {
      opts?.onTooLongLine?.({ bytes: droppedBytes, maxLineBytes })
    }
    droppedBytes = 0
  }

  const pushPart = (part: Uint8Array): void => {
    if (part.byteLength === 0)
      return
    parts.push(part)
    partsBytes += part.byteLength
  }

  const decodeParts = (): string => {
    if (partsBytes === 0)
      return ''
    if (parts.length === 1) {
      const p = parts[0]
      if (!p)
        return ''
      return decoder.decode(p)
    }
    const buf = new Uint8Array(partsBytes)
    let offset = 0
    for (const p of parts) {
      buf.set(p, offset)
      offset += p.byteLength
    }
    return decoder.decode(buf)
  }

  for await (const chunk of stream) {
    let start = 0
    while (true) {
      const nl = chunk.indexOf(10, start) // '\n'
      if (nl === -1) {
        const tail = chunk.subarray(start)
        if (dropping) {
          droppedBytes += tail.byteLength
        }
        else {
          pushPart(tail)
          if (maxLineBytes !== undefined && partsBytes > maxLineBytes) {
            if (tooLongLine === 'error') {
              throw new Error(`Line exceeds maxLineBytes (${partsBytes} > ${maxLineBytes})`)
            }
            dropping = true
            droppedBytes = partsBytes
            parts = []
            partsBytes = 0
          }
        }
        break
      }

      const head = chunk.subarray(start, nl)
      if (dropping) {
        droppedBytes += head.byteLength
        finishDroppedLine()
      }
      else {
        pushPart(head)
        if (maxLineBytes !== undefined && partsBytes > maxLineBytes) {
          if (tooLongLine === 'error')
            throw new Error(`Line exceeds maxLineBytes (${partsBytes} > ${maxLineBytes})`)
          opts?.onTooLongLine?.({ bytes: partsBytes, maxLineBytes })
        }
        else {
          yield decodeParts()
        }
      }

      parts = []
      partsBytes = 0
      start = nl + 1
    }
  }

  // Flush final partial line.
  if (dropping) {
    finishDroppedLine()
    return
  }

  if (partsBytes > 0) {
    if (flushFinalPartialLine) {
      yield decodeParts()
    }
    else {
      opts?.onFinalPartialLine?.({ bytes: partsBytes })
    }
  }
}
