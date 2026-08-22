import { ScanClient } from './ScanClient'

/**
 * The scan landing page. searchParams are read on the server so the client
 * component gets plain props and needs no Suspense boundary.
 */
export default async function ScanPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; t?: string }>
}) {
  const { s, t } = await searchParams
  return <ScanClient sessionId={s ?? ''} token={t ?? ''} />
}

export const dynamic = 'force-dynamic'
