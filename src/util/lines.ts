export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ''

  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true })
    while (true) {
      const idx = buf.indexOf('\n')
      if (idx === -1)
        break
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      yield line
    }
  }

  buf += decoder.decode()
  if (buf.length > 0) {
    yield buf
  }
}
