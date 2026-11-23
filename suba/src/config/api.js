// suba-frontend/src/config/api.js
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const BACKEND_PORT = 5001; // 5000 is taken by macOS AirPlay Receiver

// Resolve the backend URL:
// 1. EXPO_PUBLIC_API_URL (set in suba/.env) always wins — use it for a deployed server.
// 2. Otherwise, in development, reuse the host the Expo dev server runs on, so
//    simulators, emulators and physical devices on the same Wi-Fi all reach your machine.
function resolveApiUrl() {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;

  if (Platform.OS === 'web') {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `http://${host}:${BACKEND_PORT}/api`;
  }

  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.10:8081"
  const host = hostUri ? hostUri.split(':')[0] : Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
  return `http://${host}:${BACKEND_PORT}/api`;
}

export const API_URL = resolveApiUrl();
