/** Minimal stroke icon set (24×24, currentColor). */
const PATHS = {
  plug: 'M9 2v5M15 2v5M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v6',
  chip: 'M7 7h10v10H7zM10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3',
  read: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  write: 'M12 15V3M7 8l5-5 5 5M4 19h16',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  file: 'M14 3H6v18h12V7l-4-4ZM14 3v4h4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  warn: 'M12 3 2 20h20L12 3ZM12 10v4M12 17v.01',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v5M12 16v.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8v.01',
  up: 'm6 15 6-6 6 6',
  down: 'm6 9 6 6 6-6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  plus: 'M12 5v14M5 12h14',
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  eraser: 'M16 3 21 8 10 19H5l-3-3L13 5M7 21h14',
  disconnect: 'M18 6 6 18M8 3v4M16 17v4M3 8h4M17 16h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  book: 'M4 5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2V5ZM4 20a2 2 0 0 0 2 1h14M9 7h7',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
