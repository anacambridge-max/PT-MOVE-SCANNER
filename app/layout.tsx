import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PT Move Scanner',
  description: 'Pre-market and intraday move probability scanner',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
