import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/types'

function UpdateBanner({ status }: { status: UpdateStatus }): React.JSX.Element | null {
  switch (status.state) {
    case 'checking':
      return <div className="banner">Checking for launcher updates...</div>
    case 'available':
      return <div className="banner">Update {status.version} found, downloading...</div>
    case 'downloading':
      return <div className="banner">Downloading update: {status.percent}%</div>
    case 'downloaded':
      return (
        <div className="banner banner-action">
          <span>Update {status.version} is ready.</span>
          <button onClick={() => void window.api.installUpdate()}>Restart to update</button>
        </div>
      )
    case 'error':
      return <div className="banner banner-error">Update check failed: {status.message}</div>
    default:
      return null
  }
}

export default function App(): React.JSX.Element {
  const [version, setVersion] = useState('...')
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.api.getVersion().then(setVersion).catch(() => setVersion('?'))
    window.api.getUpdateStatus().then(setUpdate).catch(() => undefined)
    return window.api.onUpdateStatus(setUpdate)
  }, [])

  return (
    <div className="shell">
      <header>
        <h1>The Consortium</h1>
        <span className="version">launcher v{version}</span>
      </header>

      <UpdateBanner status={update} />

      <main>
        <p className="status">Milestone 1 in progress: login, install and Play are not wired yet.</p>
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
