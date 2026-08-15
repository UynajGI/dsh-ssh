/**
 * Shared UI utilities for the dsh-ssh client: a class-name joiner and the
 * dialog behavior every modal reuses — a document-level close stack (Esc
 * always dismisses the topmost dialog only), a Tab focus trap, initial focus,
 * and focus restoration. No external focus-management dependency.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Join truthy class-name fragments; false/null/undefined drop out. */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Live dialog closers; only the top entry reacts to Esc and Tab. */
const stack: Array<() => void> = []

/**
 * Dialog accessibility behavior for one modal while `active`.
 * Returns the ref to place on the dialog element.
 */
export function useDialogA11y(active: boolean, onClose: () => void): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!active) return
    const element = ref.current
    if (element === null) return
    const close = (): void => { closeRef.current() }
    stack.push(close)

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = (): HTMLElement[] =>
      Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(node => node.offsetParent !== null)

    element.tabIndex = -1
    const initial = element.querySelector<HTMLElement>('input, textarea, select')
    ;(initial ?? element).focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== close) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusables()
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        element.focus()
        return
      }
      const current = document.activeElement
      const atStart = current === first || current === element || current === document.body || current === null
      const atEnd = current === last || current === element || current === document.body || current === null
      if (event.shiftKey && atStart) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && atEnd) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = stack.lastIndexOf(close)
      if (index >= 0) stack.splice(index, 1)
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active])

  return ref
}
