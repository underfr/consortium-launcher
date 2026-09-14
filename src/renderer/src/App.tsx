import { useEffect, useState } from 'react'

export default function App(): React.JSX.Element {
  const [version, setVersion] = useState('…')

  useEffect(() => {
    window.api.getVersion().then(setVersion).catch(() => setVersion('?'))
  }, [])

  return (
    <div className="shell">
      <header>
        <h1>The Consortium</h1>
        <span className="version">launcher v{version}</span>
      </header>

      <main>
        <p className="status">Milestone 1 in progress - login, install and Play are not wired yet.</p>
        <button className="play" disabled>
          Play
        </button>
      </main>

      <footer>
        NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
      </footer>
    </div>
  )
}
