import type { Metadata, Viewport } from 'next'
import './globals.css'
import { THEME_SCRIPT } from '@/lib/theme'
import { ServiceWorker } from './ServiceWorker'

export const metadata: Metadata = {
  title: 'Soft Skills Attendance',
  description: 'Scan the projected QR code to be marked present.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Attendance',
  appleWebApp: {
    capable: true,
    title: 'Attendance',
    // The grid has its own dark header; a translucent bar lets it run under
    // the status bar instead of leaving a grey band.
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  formatDetection: {
    // Roll numbers and dates are not phone numbers; iOS otherwise links them.
    telephone: false,
    date: false,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximumScale or userScalable: pinch-zoom must keep working. Blocking it
  // fails WCAG 1.4.4, and the iOS focus-zoom it used to mask is solved properly
  // by keeping every input at 16px.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1120' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        {/* Must run before anything paints, or the light palette shows for a
            frame and the screen flashes white on a dark theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
        <ServiceWorker />
      </body>
    </html>
  )
}
