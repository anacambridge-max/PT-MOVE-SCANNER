import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PT Move Scanner • Upstox',
  description: 'Live NSE F&O scanner using Upstox market data and exact Chartink-style filters.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
