import { io } from 'socket.io-client'
import { SOCKET_URL } from './config.js'

export const createSocket = () => io(SOCKET_URL, {
  withCredentials: true,
  reconnection: true,
  reconnectionAttempts: 8,
  reconnectionDelay: 1000
})
