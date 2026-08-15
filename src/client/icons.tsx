/**
 * Inline SVG icon set for the dsh-ssh client UI: 16px grid, currentColor
 * stroke, no fills that fight the theme. Kept dependency-free because the
 * client bundle must stay self-contained (see tsdown.client preset).
 */

import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement>

const base: IconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M1.75 4.75c0-.69.56-1.25 1.25-1.25h3.1c.37 0 .72.16.95.44l.85 1.03h5.35c.69 0 1.25.56 1.25 1.25v6.28c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.75Z" />
    </svg>
  )
}

export function FolderPlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M1.75 4.75c0-.69.56-1.25 1.25-1.25h3.1c.37 0 .72.16.95.44l.85 1.03h5.35c.69 0 1.25.56 1.25 1.25v6.28c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.75Z" />
      <path d="M8 7.25v4M6 9.25h4" />
    </svg>
  )
}

export function MonitorIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.25" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  )
}

export function ServerIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="1.75" width="12" height="5" rx="1.25" />
      <rect x="2" y="9.25" width="12" height="5" rx="1.25" />
      <path d="M4.6 4.25h.01M4.6 11.75h.01" />
    </svg>
  )
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.75 7.25 8 2.5l5.25 4.75" />
      <path d="M4.25 6.5V13a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V6.5" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
      <path d="M13.5 2.75v2.5h-2.5" />
    </svg>
  )
}

export function EyeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.75 4.5h10.5M6.5 4.5V3.25A.75.75 0 0 1 7.25 2.5h1.5a.75.75 0 0 1 .75.75V4.5" />
      <path d="M4.25 4.5l.5 8a.75.75 0 0 0 .75.7h5a.75.75 0 0 0 .75-.7l.5-8" />
      <path d="M6.75 7.25v3.5M9.25 7.25v3.5" />
    </svg>
  )
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.25 3.75 10.5 8l-4.25 4.25" />
    </svg>
  )
}

export function KeyIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="5" cy="11" r="2.25" />
      <path d="M6.6 9.4 12.75 3.25M10.75 5.25l1.5 1.5M12.75 3.25l1.5 1.5" />
    </svg>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.25" y="7" width="9.5" height="6.25" rx="1.25" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  )
}

export function RouteIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="3.5" cy="12.5" r="1.5" />
      <circle cx="12.5" cy="3.5" r="1.5" />
      <path d="M4.75 11.25C8 10.5 10.5 8 11.25 4.75" />
    </svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2.25 14.5 13.4a.55.55 0 0 1-.48.85H1.98a.55.55 0 0 1-.48-.85L8 2.25Z" />
      <path d="M8 6.25v3.25M8 11.75h.01" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 8.6 6.4 12 13 4.5" />
    </svg>
  )
}

export function SparkIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 1.75 9.4 6.1 13.75 7.5 9.4 8.9 8 13.25 6.6 8.9 2.25 7.5 6.6 6.1 8 1.75Z" />
    </svg>
  )
}

export function SpinnerIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M13.25 8A5.25 5.25 0 1 1 8 2.75" />
    </svg>
  )
}
