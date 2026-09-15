import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.plico',
  appName: 'Plico',
  webDir: 'dist',
  plugins: {
    // Only Google is used; leaving the others out keeps their SDKs out of the native builds.
    SocialLogin: { providers: { google: true, facebook: false, apple: false, twitter: false } },
    // iOS Share Extension hands shared screenshots over through this App Group (see ios/App/ShareExtension).
    CapacitorShareTarget: { appGroupId: 'group.app.plico' },
  },
}

export default config
