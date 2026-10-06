// SVG Icon system
export default function Icon({ name, size = 18, stroke = 1.7, style, ...props }) {
  const s = size
  const common = {
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style,
    ...props,
  }
  switch (name) {
    case 'upload':
      return <svg {...common}><path d="M12 16V4M5 11l7-7 7 7"/><path d="M4 20h16"/></svg>
    case 'download':
      return <svg {...common}><path d="M12 4v12M5 13l7 7 7-7"/><path d="M4 4h16"/></svg>
    case 'folder':
      return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>
    case 'file':
      return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>
    case 'sparkles':
      return <svg {...common}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7L19 14Z"/></svg>
    case 'send':
      return <svg {...common}><path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7Z"/></svg>
    case 'close':
      return <svg {...common}><path d="M18 6 6 18M6 6l12 12"/></svg>
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    case 'chat':
      return <svg {...common}><path d="M21 11.5a8.4 8.4 0 0 1-12.5 7.3L3 21l2.2-5.5A8.4 8.4 0 1 1 21 11.5Z"/></svg>
    case 'check':
      return <svg {...common}><path d="M20 6 9 17l-5-5"/></svg>
    case 'trash':
      return <svg {...common}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>
    case 'zip':
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14M9 8h2M9 11h2M9 14h2"/></svg>
    case 'eye':
      return <svg {...common}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/></svg>
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>
    case 'clock':
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    case 'arrow-r':
      return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>
    case 'filter':
      return <svg {...common}><path d="M3 5h18l-7 9v5l-4-2v-3L3 5Z"/></svg>
    case 'layers':
      return <svg {...common}><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 17 9 5 9-5M3 12l9 5 9-5"/></svg>
    case 'building':
      return <svg {...common}><path d="M4 21V4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v17"/><path d="M13 9h5a1 1 0 0 1 1 1v11"/><path d="M2 21h20M7 8h2M7 12h2M7 16h2M16 12h1M16 16h1"/></svg>
    case 'bolt':
      return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>
    case 'menu':
      return <svg {...common}><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    case 'history':
      return <svg {...common}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
    case 'shield':
      return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>
    case 'bell':
      return <svg {...common}><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16l-2-3Z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>
    case 'trend-up':
      return <svg {...common}><path d="m23 6-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>
    case 'logout':
      return <svg {...common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
    case 'mic':
      return <svg {...common}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4M8 23h8"/></svg>
    case 'stop':
      return <svg {...common}><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
    case 'sound':
      return <svg {...common}><path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
    case 'pen':
      return <svg {...common}><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
    case 'arrow-l':
      return <svg {...common}><path d="M19 12H5M11 5l-7 7 7 7"/></svg>
    case 'save':
      return <svg {...common}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
    case 'pdf':
      return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/><path d="M8.5 17v-4h1.2a1.3 1.3 0 1 1 0 2.6H8.5m4-2.6h1.4a1.3 1.3 0 0 1 1.3 1.3v0a1.3 1.3 0 0 1-1.3 1.3H12.5m0-2.6V17m4-4h1.8M17.8 15h-1.3v2"/></svg>
    case 'word':
      return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/><path d="M7.5 13l1 4 1.2-4 1.2 4 1-4"/></svg>
    case 'doc-text':
      return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 16h6M9 10h2"/></svg>
    case 'camera':
      return <svg {...common}><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/></svg>
    case 'monitor':
      return <svg {...common}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
    case 'alert':
      return <svg {...common}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>
    case 'user':
      return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
    case 'calendar':
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
    case 'chevron-down':
      return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>
    case 'info':
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
    case 'checklist':
      return <svg {...common}><path d="m3 6 2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3"/><path d="M12 6h9M12 13h9M12 20h9"/></svg>
    case 'circle-check':
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>
    case 'paperclip':
      return <svg {...common}><path d="m21 11-9.2 9.2a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4L15 7.5"/></svg>
    case 'refresh':
      return <svg {...common}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
    default:
      return null
  }
}
