import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'

export interface SelectOption<T extends string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

export interface PromptIO {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

export class PromptCancelledError extends Error {
  override name = 'PromptCancelledError'
}

export async function promptText(
  io: PromptIO,
  message: string,
  opts?: { defaultValue?: string, required?: boolean },
): Promise<string> {
  const { input, output } = io
  assertTty(input, output)

  const rl = createInterface({ input, output })
  try {
    for (;;) {
      const suffix = opts?.defaultValue ? ` [${opts.defaultValue}]` : ''
      const raw = await rl.question(`${message}${suffix}: `)
      const value = raw.trim() || opts?.defaultValue || ''
      if (opts?.required === true && value.length === 0) {
        output.write(`${dim('Value is required.')}\n`)
        continue
      }
      return value
    }
  }
  finally {
    rl.close()
  }
}

export async function promptNumber(
  io: PromptIO,
  message: string,
  opts: { defaultValue: number, min: number },
): Promise<number> {
  for (;;) {
    const raw = await promptText(io, message, { defaultValue: String(opts.defaultValue), required: true })
    const n = Number(raw)
    if (!Number.isFinite(n) || n < opts.min) {
      io.output.write(`${dim(`Value must be a number >= ${opts.min}.`)}\n`)
      continue
    }
    return n
  }
}

export async function promptSelect<T extends string>(
  io: PromptIO,
  message: string,
  options: Array<SelectOption<T>>,
  opts?: {
    initialValue?: T
    pageSize?: number
    filterable?: boolean
  },
): Promise<T> {
  const pageSize = opts?.pageSize ?? 12
  const filterable = opts?.filterable ?? options.length >= 12

  const { input, output } = io
  assertTty(input, output)

  const initialIdx = opts?.initialValue
    ? Math.max(0, options.findIndex(o => o.value === opts.initialValue))
    : 0

  let filter = ''
  let activeIdx = initialIdx
  let renderedLines = 0

  const computeVisible = (): Array<{ opt: SelectOption<T>, idx: number }> => {
    const f = filter.trim().toLowerCase()
    const out: Array<{ opt: SelectOption<T>, idx: number }> = []
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]
      if (!opt)
        continue
      if (!f) {
        out.push({ opt, idx: i })
        continue
      }
      const hay = `${opt.label} ${opt.value}`.toLowerCase()
      if (hay.includes(f))
        out.push({ opt, idx: i })
    }
    return out
  }

  const moveActive = (delta: number, visible: Array<{ opt: SelectOption<T>, idx: number }>): void => {
    if (visible.length === 0)
      return
    let next = activeIdx
    for (let step = 0; step < visible.length; step++) {
      next = wrap(next + delta, visible.length)
      const v = visible[next]
      if (v && v.opt.disabled !== true) {
        activeIdx = next
        return
      }
    }
  }

  const ensureActiveSelectable = (visible: Array<{ opt: SelectOption<T>, idx: number }>): void => {
    if (visible.length === 0)
      return
    const cur = visible[activeIdx]
    if (cur && cur.opt.disabled !== true)
      return
    for (let i = 0; i < visible.length; i++) {
      const v = visible[i]
      if (v && v.opt.disabled !== true) {
        activeIdx = i
        return
      }
    }
  }

  const clearRendered = (): void => {
    if (renderedLines <= 0)
      return
    output.write(`\x1B[${renderedLines}A`)
    output.write('\x1B[J')
    renderedLines = 0
  }

  const render = (): Array<{ opt: SelectOption<T>, idx: number }> => {
    const visible = computeVisible()
    if (activeIdx >= visible.length)
      activeIdx = Math.max(0, visible.length - 1)
    ensureActiveSelectable(visible)

    const cols = typeof output.columns === 'number' ? output.columns : 80
    const lines: string[] = []
    lines.push(`${bold('?')} ${message}${filterable ? ` ${dim('(type to filter)')}` : ''}`)
    if (filterable) {
      lines.push(`${dim('Search:')} ${filter}`)
    }
    lines.push('')

    if (visible.length === 0) {
      lines.push(dim('(no matches)'))
    }
    else {
      const start = clamp(
        activeIdx - Math.floor(pageSize / 2),
        0,
        Math.max(0, visible.length - pageSize),
      )
      const window = visible.slice(start, start + pageSize)
      for (let i = 0; i < window.length; i++) {
        const v = window[i]
        if (!v)
          continue
        const isActive = start + i === activeIdx
        const label = formatOptionLine(v.opt, { isActive })
        lines.push(label)
      }
      if (visible.length > window.length) {
        lines.push(dim(`(${start + 1}-${start + window.length} of ${visible.length})`))
      }
    }

    lines.push(dim('Enter=select, Esc=cancel, Ctrl+C=cancel, Up/Down=navigate'))

    clearRendered()
    for (const line of lines) {
      output.write(`${truncateToColumns(line, cols)}\n`)
    }
    renderedLines = lines.length
    return visible
  }

  const setCursorVisible = (visible: boolean): void => {
    output.write(visible ? '\x1B[?25h' : '\x1B[?25l')
  }

  return await new Promise<T>((resolve, reject) => {
    const wasRaw = typeof input.isRaw === 'boolean' ? input.isRaw : false
    let done = false

    let onKeypress: (str: string, key?: { name?: string, ctrl?: boolean, meta?: boolean }) => void = () => {}

    const finish = (fn: () => void): void => {
      if (done)
        return
      done = true
      try {
        clearRendered()
        setCursorVisible(true)
        input.setRawMode?.(wasRaw)
        input.pause()
        ;(input as any).off?.('keypress', onKeypress)
      }
      catch {}
      fn()
    }

    const cancel = (): void => {
      finish(() => reject(new PromptCancelledError('Cancelled.')))
    }

    onKeypress = (str: string, key: { name?: string, ctrl?: boolean, meta?: boolean } = {}): void => {
      if (key.ctrl === true && key.name === 'c')
        return cancel()
      if (key.name === 'escape')
        return cancel()

      const visible = computeVisible()
      if (key.name === 'up') {
        moveActive(-1, visible)
        render()
        return
      }
      if (key.name === 'down') {
        moveActive(1, visible)
        render()
        return
      }
      if (key.name === 'pageup') {
        activeIdx = clamp(activeIdx - pageSize, 0, Math.max(0, visible.length - 1))
        render()
        return
      }
      if (key.name === 'pagedown') {
        activeIdx = clamp(activeIdx + pageSize, 0, Math.max(0, visible.length - 1))
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const selected = visible[activeIdx]
        if (!selected || selected.opt.disabled === true)
          return
        finish(() => {
          output.write(`${bold('?')} ${message}: ${selected.opt.label}\n`)
          resolve(selected.opt.value)
        })
        return
      }

      if (!filterable)
        return

      if (key.name === 'backspace' || key.name === 'delete') {
        filter = filter.slice(0, -1)
        activeIdx = 0
        render()
        return
      }

      if (key.meta === true)
        return
      if (typeof str !== 'string' || str.length === 0)
        return
      if (!isPrintable(str))
        return

      filter += str
      activeIdx = 0
      render()
    }

    try {
      emitKeypressEvents(input)
      input.setRawMode?.(true)
      input.resume()
      setCursorVisible(false)
      ;(input as any).on?.('keypress', onKeypress)

      render()
    }
    catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    }
  })
}

export async function promptConfirm(
  io: PromptIO,
  message: string,
  opts?: { initialValue?: boolean },
): Promise<boolean> {
  const v = await promptSelect(io, message, [
    { label: 'Yes', value: 'yes' },
    { label: 'No', value: 'no' },
  ], { initialValue: opts?.initialValue === false ? 'no' : 'yes', filterable: false, pageSize: 2 })
  return v === 'yes'
}

export async function promptPassword(
  io: PromptIO,
  message: string,
  opts?: { required?: boolean },
): Promise<string> {
  const { input, output } = io
  assertTty(input, output)

  let renderedLines = 0
  let value = ''

  const clearRendered = (): void => {
    if (renderedLines <= 0)
      return
    output.write(`\x1B[${renderedLines}A`)
    output.write('\x1B[J')
    renderedLines = 0
  }

  const render = (): void => {
    const cols = typeof output.columns === 'number' ? output.columns : 80
    const lines: string[] = []
    lines.push(`${bold('?')} ${message}: ${'*'.repeat(value.length)}`)
    lines.push(dim('Enter=submit, Esc=cancel, Ctrl+C=cancel, Backspace=delete'))

    clearRendered()
    for (const line of lines) {
      output.write(`${truncateToColumns(line, cols)}\n`)
    }
    renderedLines = lines.length
  }

  const setCursorVisible = (visible: boolean): void => {
    output.write(visible ? '\x1B[?25h' : '\x1B[?25l')
  }

  return await new Promise<string>((resolve, reject) => {
    const wasRaw = typeof input.isRaw === 'boolean' ? input.isRaw : false
    let done = false

    let onKeypress: (str: string, key?: { name?: string, ctrl?: boolean, meta?: boolean }) => void = () => {}

    const finish = (fn: () => void): void => {
      if (done)
        return
      done = true
      try {
        clearRendered()
        setCursorVisible(true)
        input.setRawMode?.(wasRaw)
        input.pause()
        ;(input as any).off?.('keypress', onKeypress)
      }
      catch {}
      fn()
    }

    const cancel = (): void => {
      finish(() => reject(new PromptCancelledError('Cancelled.')))
    }

    onKeypress = (str: string, key: { name?: string, ctrl?: boolean, meta?: boolean } = {}): void => {
      if (key.ctrl === true && key.name === 'c')
        return cancel()
      if (key.name === 'escape')
        return cancel()
      if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1)
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (opts?.required === true && value.length === 0) {
          output.write(`${dim('Password is required.')}\n`)
          renderedLines += 1
          return
        }
        finish(() => resolve(value))
        return
      }
      if (key.meta === true)
        return
      if (typeof str !== 'string' || str.length === 0)
        return
      if (!isPrintable(str))
        return

      value += str
      render()
    }

    try {
      emitKeypressEvents(input)
      input.setRawMode?.(true)
      input.resume()
      setCursorVisible(false)
      ;(input as any).on?.('keypress', onKeypress)

      render()
    }
    catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    }
  })
}

function formatOptionLine(opt: SelectOption<string>, opts: { isActive: boolean }): string {
  const prefix = opts.isActive ? '> ' : '  '
  // Avoid nested ANSI resets within inverse-highlighted lines.
  const hint = opt.hint ? ` ${opts.isActive ? opt.hint : dim(opt.hint)}` : ''
  const label = `${prefix}${opt.label}${hint}`
  if (opt.disabled === true)
    return dim(label)
  if (opts.isActive)
    return inverse(label)
  return label
}

function assertTty(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error('Prompt requires an interactive terminal (TTY).')
  }
}

function truncateToColumns(text: string, columns: number): string {
  const max = Math.max(0, columns - 1)
  if (text.length <= max)
    return text
  if (max <= 3)
    return text.slice(0, max)
  return `${text.slice(0, max - 3)}...`
}

function bold(text: string): string {
  return `\x1B[1m${text}\x1B[0m`
}

function dim(text: string): string {
  return `\x1B[2m${text}\x1B[0m`
}

function inverse(text: string): string {
  return `\x1B[7m${text}\x1B[0m`
}

function wrap(n: number, len: number): number {
  if (len <= 0)
    return 0
  const m = n % len
  return m < 0 ? m + len : m
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function isPrintable(str: string): boolean {
  if (str.length !== 1)
    return false
  const code = str.charCodeAt(0)
  return code >= 0x20 && code !== 0x7F
}
