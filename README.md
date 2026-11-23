# Suba

Subscription tracker: Expo (React Native) app in `suba/`, Express + MySQL API in `suba-backend/`.

## Run locally

1. **MySQL 8** running on `127.0.0.1:3306`.
2. **Backend**
   ```bash
   cd suba-backend
   cp .env.example .env   # set DB_USER / DB_PASSWORD / JWT_SECRET
   npm install
   npm run migrate        # creates the database + tables (safe to re-run)
   npm start              # http://localhost:5001
   ```
   Port 5001 is used because macOS AirPlay Receiver occupies 5000.
3. **App**
   ```bash
   cd suba
   npm install
   npx expo start         # press w for web, i for iOS simulator, or scan with Expo Go
   ```
   The app talks to the backend on the same machine as the Expo dev server (port 5001).
   To use a deployed API instead, set `EXPO_PUBLIC_API_URL=https://your-host/api` in `suba/.env`.

AI insights use Gemini when `GEMINI_API_KEY` is set in `suba-backend/.env`; otherwise rule-based insights are returned.
