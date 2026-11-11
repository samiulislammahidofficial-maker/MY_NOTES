import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { actions, useApp } from './store';
import { Library } from './Library';
import { Editor } from './Editor';
import { Welcome } from './Welcome';
import { Opening } from './Opening';

export default function App() {
  const ready = useApp((s) => s.ready);
  const mode = useApp((s) => s.mode);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    actions.init().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Storage failed to open'));
  }, [attempt]);

  return (
    <>
      {ready ? mode === 'welcome' ? <Welcome /> : mode === 'library' ? <Library /> : <Editor /> : null}
      <Opening ready={ready} error={error} onRetry={() => setAttempt((a) => a + 1)} />
      <Analytics />
      <SpeedInsights />
    </>
  );
}
