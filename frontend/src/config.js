const apiUrl = import.meta.env.VITE_API_URL || '/api'
const socketUrl = import.meta.env.VITE_SOCKET_URL || window.location.origin

if (!apiUrl || !socketUrl) {
  throw new Error('VITE_API_URL and VITE_SOCKET_URL must be configured')
}

export const API_BASE = apiUrl.replace(/\/+$/, '')
export const SOCKET_URL = socketUrl.replace(/\/+$/, '')
