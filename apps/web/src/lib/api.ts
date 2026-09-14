export type User = {
  id: string
  username: string
  email?: string | null
  role: 'admin' | 'user'
  status: string
  quota_bytes: number
  created_at: string
}

export type Workspace = {
  id: string
  owner_user_id: string
  name: string
  created_at: string
}

export type NodeItem = {
  id: string
  workspace_id: string
  parent_id: string | null
  type: 'folder' | 'file'
  name: string
  ext: string
  size_bytes: number
  mime?: string | null
  is_starred: boolean
  version: number
  editor_key?: string | null
  deleted_at?: string | null
  created_at: string
  updated_at: string
  content_hash?: string | null
  sort_order?: number
}

export type OfficeConfig = {
  documentType: string
  document: Record<string, unknown>
  editorConfig: Record<string, unknown>
  token: string
  docs_api_script: string
}

const TOKEN_KEY = 'weidoc_access_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

type ApiError = { code?: string; message?: string }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...init, headers, credentials: 'include' })
  if (res.status === 401 && !path.includes('/auth/login') && !path.includes('/auth/setup') && !path.includes('/auth/refresh') && !path.includes('/auth/me')) {
    // try refresh once
    const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    if (refreshed.ok) {
      const data = await refreshed.json()
      setToken(data.access_token)
      headers.set('Authorization', `Bearer ${data.access_token}`)
      const retry = await fetch(path, { ...init, headers, credentials: 'include' })
      if (!retry.ok) {
        const err = (await retry.json().catch(() => ({}))) as ApiError
        throw new Error(err.message || `HTTP ${retry.status}`)
      }
      if (retry.status === 204) return undefined as T
      return retry.json()
    }
    setToken(null)
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(err.message || `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  setupStatus: () => request<{ setup: boolean }>('/api/v1/auth/setup/status'),
  setup: (username: string, password: string) =>
    request<{ access_token: string; user: User }>('/api/v1/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ access_token: string; user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request('/api/v1/auth/logout', { method: 'POST' }),
  me: () => request<User>('/api/v1/auth/me'),
  workspaces: () => request<Workspace[]>('/api/v1/workspaces'),
  tree: (wid: string, parentId?: string | null) => {
    const q = parentId ? `?parent_id=${parentId}` : ''
    return request<NodeItem[]>(`/api/v1/workspaces/${wid}/tree${q}`)
  },
  createFolder: (wid: string, name: string, parent_id?: string | null) =>
    request<NodeItem>(`/api/v1/workspaces/${wid}/folders`, {
      method: 'POST',
      body: JSON.stringify({ name, parent_id: parent_id || null }),
    }),
  createFile: (wid: string, kind: string, name?: string, parent_id?: string | null) =>
    request<NodeItem>(`/api/v1/workspaces/${wid}/files`, {
      method: 'POST',
      body: JSON.stringify({ kind, name, parent_id: parent_id || null }),
    }),
  upload: async (wid: string, file: File, parent_id?: string | null) => {
    const fd = new FormData()
    fd.append('file', file)
    if (parent_id) fd.append('parent_id', parent_id)
    return request<NodeItem>(`/api/v1/workspaces/${wid}/upload`, { method: 'POST', body: fd })
  },
  importInto: async (wid: string, id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<NodeItem>(`/api/v1/workspaces/${wid}/files/${id}/import`, { method: 'POST', body: fd })
  },
  rename: (wid: string, id: string, name: string) =>
    request<NodeItem>(`/api/v1/workspaces/${wid}/nodes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  move: (wid: string, ids: string[], target_parent_id: string | null, before_id?: string | null) =>
    request(`/api/v1/workspaces/${wid}/nodes/move`, {
      method: 'POST',
      body: JSON.stringify({
        ids,
        target_parent_id,
        before_id: before_id ?? null,
      }),
    }),
  copy: (wid: string, id: string) =>
    request<NodeItem>(`/api/v1/workspaces/${wid}/nodes/${id}/copy`, { method: 'POST' }),
  remove: (wid: string, id: string) =>
    request(`/api/v1/workspaces/${wid}/nodes/${id}`, { method: 'DELETE' }),
  trash: (wid: string) => request<NodeItem[]>(`/api/v1/workspaces/${wid}/trash`),
  restore: (wid: string, id: string) =>
    request<NodeItem>(`/api/v1/workspaces/${wid}/trash/${id}/restore`, { method: 'POST' }),
  hardDelete: (wid: string, id: string) =>
    request(`/api/v1/workspaces/${wid}/trash/${id}`, { method: 'DELETE' }),
  getContent: (wid: string, id: string) =>
    request<{ node: NodeItem; content: string; version: number }>(`/api/v1/workspaces/${wid}/files/${id}/content`),
  putContent: (wid: string, id: string, content: string, version: number) =>
    request<NodeItem>(`/api/v1/workspaces/${wid}/files/${id}/content`, {
      method: 'PUT',
      headers: { 'If-Match': String(version) },
      body: JSON.stringify({ content, version }),
    }),
  downloadUrl: (wid: string, id: string) => `/api/v1/workspaces/${wid}/files/${id}/download`,
  officeSession: (wid: string, id: string, mode: 'view' | 'edit') =>
    request<OfficeConfig>(`/api/v1/workspaces/${wid}/files/${id}/office/session`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  search: (wid: string, q: string) =>
    request<NodeItem[]>(`/api/v1/workspaces/${wid}/search?q=${encodeURIComponent(q)}`),
  recents: () => request<NodeItem[]>('/api/v1/recents'),
  adminUsers: () => request<User[]>('/api/v1/admin/users'),
  createUser: (username: string, password: string, role = 'user') =>
    request<User>('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    }),
  setUserStatus: (id: string, status: string) =>
    request<{ ok: boolean }>(`/api/v1/admin/users/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  settings: () =>
    request<{
      public_base_url: string
      onlyoffice_url: string
      onlyoffice_enabled: boolean
      max_upload_bytes: number
      trash_retention_days: number
    }>('/api/v1/admin/settings'),
}
