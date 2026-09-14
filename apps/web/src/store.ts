import { create } from 'zustand'
import { api, getToken, setToken, type User, type Workspace, type NodeItem } from './lib/api'

type AuthState = {
  user: User | null
  loading: boolean
  boot: () => Promise<void>
  login: (u: string, p: string) => Promise<void>
  setup: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  boot: async () => {
    if (!getToken()) {
      set({ user: null, loading: false })
      return
    }
    try {
      const user = await api.me()
      set({ user, loading: false })
    } catch {
      setToken(null)
      set({ user: null, loading: false })
    }
  },
  login: async (username, password) => {
    const res = await api.login(username, password)
    setToken(res.access_token)
    set({ user: res.user })
  },
  setup: async (username, password) => {
    const res = await api.setup(username, password)
    setToken(res.access_token)
    set({ user: res.user })
  },
  logout: async () => {
    try { await api.logout() } catch { /* ignore */ }
    setToken(null)
    set({ user: null })
  },
}))

type AppState = {
  workspace: Workspace | null
  nodesByParent: Record<string, NodeItem[]>
  expanded: Record<string, boolean>
  selectedId: string | null
  trashMode: boolean
  setWorkspace: (w: Workspace | null) => void
  loadChildren: (parentId: string | null) => Promise<NodeItem[]>
  refreshParent: (parentId: string | null) => Promise<void>
  setSelected: (id: string | null) => void
  toggleExpand: (id: string) => void
  setTrashMode: (v: boolean) => void
  upsertNode: (n: NodeItem) => void
  removeNodeLocal: (id: string, parentId: string | null) => void
}

const parentKey = (id: string | null) => id || 'root'

export const useApp = create<AppState>((set, get) => ({
  workspace: null,
  nodesByParent: {},
  expanded: {},
  selectedId: null,
  trashMode: false,
  setWorkspace: (w) => set({ workspace: w, nodesByParent: {}, expanded: {}, selectedId: null }),
  loadChildren: async (parentId) => {
    const wid = get().workspace?.id
    if (!wid) return []
    const list = await api.tree(wid, parentId)
    set((s) => ({ nodesByParent: { ...s.nodesByParent, [parentKey(parentId)]: list } }))
    return list
  },
  refreshParent: async (parentId) => {
    await get().loadChildren(parentId)
  },
  setSelected: (id) => set({ selectedId: id, trashMode: false }),
  toggleExpand: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setTrashMode: (v) => set({ trashMode: v, selectedId: v ? null : get().selectedId }),
  upsertNode: (n) => {
    const key = parentKey(n.parent_id)
    set((s) => {
      const list = [...(s.nodesByParent[key] || [])]
      const idx = list.findIndex((x) => x.id === n.id)
      if (idx >= 0) list[idx] = n
      else list.push(n)
      list.sort((a, b) => {
        const ao = a.sort_order ?? 0
        const bo = b.sort_order ?? 0
        if (ao !== bo) return ao - bo
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return { nodesByParent: { ...s.nodesByParent, [key]: list } }
    })
  },
  removeNodeLocal: (id, parentId) => {
    const key = parentKey(parentId)
    set((s) => ({
      nodesByParent: {
        ...s.nodesByParent,
        [key]: (s.nodesByParent[key] || []).filter((x) => x.id !== id),
      },
      selectedId: s.selectedId === id ? null : s.selectedId,
    }))
  },
}))
