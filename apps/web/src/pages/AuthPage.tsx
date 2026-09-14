import { FormEvent, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../store'

export function AuthPage() {
  const { login, setup } = useAuth()
  const [needSetup, setNeedSetup] = useState<boolean | null>(null)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.setupStatus().then((s) => setNeedSetup(!s.setup)).catch(() => setNeedSetup(false))
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (needSetup) await setup(username, password)
      else await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  if (needSetup === null) {
    return (
      <div className="auth-page">
        <div className="sakura-layer" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => <span key={i} className="sakura" />)}
        </div>
        <div className="muted">加载中…</div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="sakura-layer" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => <span key={i} className="sakura" />)}
      </div>
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="auth-sparkle" aria-hidden />
        <div className="brand-hero">
          <div className="logo-row">
            <span className="brand-mark" aria-hidden />
            <h1>微文档</h1>
          </div>
          <span className="auth-badge">星樱手帐 · 私人云笔记</span>
        </div>
        <p>{needSetup ? '首次安装：创建管理员账号，开启你的文档宇宙' : '登录后管理你的笔记与办公文件'}</p>
        <label>用户名</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        <label>密码（至少 8 位）</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
        <button className="btn primary" disabled={loading}>
          {loading ? '处理中…' : needSetup ? '完成安装' : '进入微文档'}
        </button>
      </form>
    </div>
  )
}
