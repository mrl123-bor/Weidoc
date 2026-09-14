import { useEffect } from 'react'
import { useAuth } from './store'
import { AuthPage } from './pages/AuthPage'
import { AppShell } from './pages/AppShell'

function useVisualViewport() {
  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const vv = window.visualViewport
      const h = vv?.height ?? window.innerHeight
      root.style.setProperty('--vvh', `${Math.round(h)}px`)
      const covered = window.innerHeight - h
      root.classList.toggle('kb-open', covered > 80)
    }
    apply()
    const vv = window.visualViewport
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      root.classList.remove('kb-open')
    }
  }, [])
}

export default function App() {
  const { user, loading, boot } = useAuth()
  useVisualViewport()
  useEffect(() => { void boot() }, [boot])
  if (loading) {
    return (
      <div className="auth-page">
        <div className="sakura-layer" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => <span key={i} className="sakura" />)}
        </div>
        <div className="muted">启动中…</div>
      </div>
    )
  }
  return user ? <AppShell /> : <AuthPage />
}
