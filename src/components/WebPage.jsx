import { forwardRef, useMemo } from 'react'
import { sections } from '../content/article.js'

// Inline markup used in article.js:
//   [label](kind)  -> <a>, kind decides colour/icon/highlight style
//   [n](cite)      -> <sup><a>[n]</a></sup>
//   *text*         -> <em>
const TOKEN = /(\[[^\]]+\]\([a-z]+\)|\*[^*]+\*)/g
const LINK = /^\[([^\]]+)\]\(([a-z]+)\)$/
const EXTERNAL_KINDS = new Set(['external', 'oclc', 'doi', 'pmid', 'pmc', 'bibcode'])

function parseInline(text, nextId) {
  return text.split(TOKEN).filter(Boolean).map((part, index) => {
    const link = part.match(LINK)
    if (link) {
      const [, label, kind] = link
      const id = nextId()
      const anchor = (
        <a
          key={index}
          href={`#${id}`}
          data-target-id={id}
          data-kind={kind}
          className={EXTERNAL_KINDS.has(kind) ? 'ext' : undefined}
        >
          {kind === 'cite' ? `[${label}]` : label}
        </a>
      )
      return kind === 'cite' ? <sup key={index}>{anchor}</sup> : anchor
    }
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      return <em key={index}>{part.slice(1, -1)}</em>
    }
    return part
  })
}

function renderBlock(block, key, nextId) {
  switch (block.type) {
    case 'p':
      return <p key={key}>{parseInline(block.text, nextId)}</p>
    case 'list':
      return (
        <ul key={key}>
          {block.items.map((item, i) => <li key={i}>{parseInline(item, nextId)}</li>)}
        </ul>
      )
    case 'refs':
      return (
        <ol key={key} className="refs">
          {block.items.map((item, i) => <li key={i}>^ {parseInline(item, nextId)}</li>)}
        </ol>
      )
    default:
      return null
  }
}

const WebPage = forwardRef(function WebPage(_props, ref) {
  // Built once, so every link keeps a stable data-target-id across renders.
  const content = useMemo(() => {
    let counter = 0
    const nextId = () => `link-${counter++}`
    return sections.map((section, i) => (
      <section key={i}>
        {section.heading && <h2>{section.heading}</h2>}
        {section.blocks.map((block, j) => renderBlock(block, j, nextId))}
      </section>
    ))
  }, [])

  // Links are real <a> elements, but we don't want them to navigate or jump the page.
  const swallowLinkClicks = (event) => {
    if (event.target.closest('a')) event.preventDefault()
  }

  return (
    <main className="page" ref={ref} onClick={swallowLinkClicks}>
      <h1>Spiders</h1>
      <p className="page__tagline">Order Araneae</p>
      {content}
      <footer className="page__footer">
        Sample text written for the Webbie prototype. Citation identifiers are illustrative
        and are not guaranteed to resolve.
      </footer>
    </main>
  )
})

export default WebPage