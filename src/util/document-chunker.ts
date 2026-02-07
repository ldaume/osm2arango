export interface DocumentChunker<T> {
  push: (doc: T) => T[] | undefined
  flush: () => T[] | undefined
}

export function createDocumentChunker<T>(maxBytes: number): DocumentChunker<T> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid maxBytes: ${maxBytes}`)
  }

  const docs: T[] = []
  let bytes = 0

  const flush = (): T[] | undefined => {
    if (docs.length === 0)
      return undefined
    const chunk = docs.slice()
    docs.length = 0
    bytes = 0
    return chunk
  }

  const push = (doc: T): T[] | undefined => {
    // We chunk by approximate payload size. The actual request overhead is a bit higher
    // (JSON array delimiters, commas), but this keeps memory bounded deterministically.
    const docBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8') + 1

    if (docs.length > 0 && bytes + docBytes > maxBytes) {
      const chunk = flush()
      docs.push(doc)
      bytes += docBytes
      return chunk
    }

    docs.push(doc)
    bytes += docBytes
    return undefined
  }

  return { push, flush }
}
