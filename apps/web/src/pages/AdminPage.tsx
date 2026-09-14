import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Users, HardDrive, FileStack, CheckCircle2, AlertCircle,
  Cloud, Shield, UserPlus,
} from 'lucide-react'
import { api, type User } from '../lib/api'
import { useAuth } from '../store'
import { ConfirmDialog } from '../components/ui/Dialog'

type Settings = {
  public_base_url: string
  onlyoffice_url: string
  onlyoffice_enabled: boolean
  max_upload_bytes: number
  trash_retention_days: number
}

function formatBytes(n: number) {
  if (!n || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

function roleLabel(role: string) {
  return role === 'admin' ? '管理员' : '普通用户'
}

function statusLabel(status: string) {
  return status === 'active' ? '正常' : status === 'disabled' ? '已停用' : status
}

export function AdminPage({ onBack }: { onBack: () => void }) {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmUser, setConfirmUser] = useState<User | null>(null)

  async function reload() {
    const [u, s] = await Promise.all([api.adminUsers(), api.settings()])
    setUsers(u)
    setSettings(s)
  }

  useEffect(() => { void reload().catch((e) => setError(e instanceof Error ? e.message : '加载失败')) }, [])

  const stats = useMemo(() => {
    const active = users.filter((u) => u.status === 'active').length
    const admins = users.filter((u) => u.role === 'admin').length
    return { total: users.length, active, admins }
  }, [users])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError('')
    setMsg('')
    setBusy(true)
    try {
      await api.createUser(username, password, role)
      setUsername('')
      setPassword('')
      setRole('user')
      setMsg(`已创建用户「${username}」`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function toggleStatus(u: User) {
    setConfirmUser(u)
  }

  async function applyStatus() {
    if (!confirmUser) return
    const next = confirmUser.status === 'active' ? 'disabled' : 'active'
    setBusy(true)
    try {
      await api.setUserStatus(confirmUser.id, next)
      setMsg(next === 'disabled' ? `已停用 ${confirmUser.username}` : `已启用 ${confirmUser.username}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
      setConfirmUser(null)
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-hero">
        <div>
          <div className="admin-kicker">管理员控制台</div>
          <h1>系统管理</h1>
          <p>管理账号、查看服务状态与容量策略。这里只给管理员用。</p>
        </div>
        <button className="btn soft" onClick={onBack}>
          <ArrowLeft size={16} /> 返回文档
        </button>
      </div>

      {(msg || error) && (
        <div className={`admin-toast ${error ? 'is-error' : 'is-ok'}`}>
          {error || msg}
        </div>
      )}

      <div className="admin-stats">
        <div className="stat-card">
          <div className="stat-icon tone-md"><Users size={18} /></div>
          <div>
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">全部用户</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon tone-xls"><CheckCircle2 size={18} /></div>
          <div>
            <div className="stat-value">{stats.active}</div>
            <div className="stat-label">正常账号</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon tone-ppt"><Shield size={18} /></div>
          <div>
            <div className="stat-value">{stats.admins}</div>
            <div className="stat-label">管理员</div>
          </div>
        </div>
        <div className="stat-card">
          <div className={`stat-icon ${settings?.onlyoffice_enabled ? 'tone-doc' : 'tone-pdf'}`}>
            {settings?.onlyoffice_enabled ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          </div>
          <div>
            <div className="stat-value">{settings?.onlyoffice_enabled ? '已就绪' : '未配置'}</div>
            <div className="stat-label">Office 文档服务</div>
          </div>
        </div>
      </div>

      <div className="admin-grid">
        <section className="admin-panel">
          <div className="admin-panel-head">
            <h2>服务状态</h2>
            <span className="muted">运行环境一览</span>
          </div>
          <div className="service-list">
            <div className="service-row">
              <div className="service-left">
                <span className="file-badge tone-doc"><Cloud size={14} /></span>
                <div>
                  <strong>访问地址</strong>
                  <p>{settings?.public_base_url || '—'}</p>
                </div>
              </div>
              <span className="status-pill ok">对外入口</span>
            </div>
            <div className="service-row">
              <div className="service-left">
                <span className="file-badge tone-ppt"><FileStack size={14} /></span>
                <div>
                  <strong>OnlyOffice</strong>
                  <p>{settings?.onlyoffice_url || '未配置'}</p>
                </div>
              </div>
              <span className={`status-pill ${settings?.onlyoffice_enabled ? 'ok' : 'warn'}`}>
                {settings?.onlyoffice_enabled ? '可用' : '不可用'}
              </span>
            </div>
            <div className="service-row">
              <div className="service-left">
                <span className="file-badge tone-xls"><HardDrive size={14} /></span>
                <div>
                  <strong>单文件上传上限</strong>
                  <p>{formatBytes(settings?.max_upload_bytes || 0)}</p>
                </div>
              </div>
              <span className="status-pill soft">容量策略</span>
            </div>
            <div className="service-row">
              <div className="service-left">
                <span className="file-badge tone-folder"><TrashIcon /></span>
                <div>
                  <strong>回收站保留</strong>
                  <p>{settings?.trash_retention_days ?? '—'} 天</p>
                </div>
              </div>
              <span className="status-pill soft">自动清理</span>
            </div>
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <h2>新建用户</h2>
            <span className="muted">邀请成员加入微文档</span>
          </div>
          <form className="admin-form" onSubmit={onCreate}>
            <label>
              用户名
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="例如：xiaoming" required />
            </label>
            <label>
              初始密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位" required minLength={8} />
            </label>
            <label>
              角色
              <select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <button className="btn primary" disabled={busy}>
              <UserPlus size={16} /> 创建账号
            </button>
          </form>
        </section>
      </div>

      <section className="admin-panel admin-users">
        <div className="admin-panel-head">
          <h2>用户列表</h2>
          <span className="muted">共 {users.length} 人</span>
        </div>
        <div className="user-table-wrap">
          <table className="user-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>状态</th>
                <th>配额</th>
                <th>创建时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="user-cell">
                      <span className="user-chip-avatar">{u.username.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <strong>{u.username}</strong>
                        {u.email ? <div className="muted tiny">{u.email}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td><span className={`role-tag ${u.role}`}>{roleLabel(u.role)}</span></td>
                  <td>
                    <span className={`status-dot ${u.status === 'active' ? 'ok' : 'off'}`}>
                      {statusLabel(u.status)}
                    </span>
                  </td>
                  <td>{formatBytes(u.quota_bytes)}</td>
                  <td className="muted">{formatDate(u.created_at)}</td>
                  <td className="actions">
                    {me?.id === u.id ? (
                      <span className="muted tiny">当前账号</span>
                    ) : (
                      <button
                        className={`btn soft ${u.status === 'active' ? 'danger-soft' : ''}`}
                        disabled={busy}
                        onClick={() => void toggleStatus(u)}
                      >
                        {u.status === 'active' ? '停用' : '启用'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>暂无用户</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmDialog
        open={!!confirmUser}
        title={confirmUser?.status === 'active' ? '停用账号' : '启用账号'}
        message={
          confirmUser
            ? confirmUser.status === 'active'
              ? `确定停用「${confirmUser.username}」？停用后该用户将无法登录。`
              : `确定重新启用「${confirmUser.username}」？`
            : ''
        }
        confirmText={confirmUser?.status === 'active' ? '停用' : '启用'}
        danger={confirmUser?.status === 'active'}
        onClose={() => setConfirmUser(null)}
        onConfirm={applyStatus}
      />
    </div>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />
    </svg>
  )
}

function formatDate(iso: string) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}
