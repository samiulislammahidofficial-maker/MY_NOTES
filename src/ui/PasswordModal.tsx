import { useState } from 'react';
import { Eye, EyeOff, Lock, X } from 'lucide-react';

export type PasswordModalMode = 'set' | 'unlock' | 'change' | 'remove';

export interface PasswordModalProps {
  mode: PasswordModalMode;
  targetName: string;
  targetKind: 'notebook' | 'page';
  onClose: () => void;
  onSubmit: (data: { currentPassword?: string; newPassword?: string }) => Promise<void>;
}

export function PasswordModal({
  mode,
  targetName,
  targetKind,
  onClose,
  onSubmit,
}: PasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const titles: Record<PasswordModalMode, string> = {
    set: `Set Password`,
    unlock: `Unlock ${targetKind === 'page' ? 'Page' : 'Notebook'}`,
    change: `Change Password`,
    remove: `Remove Password`,
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'unlock' || mode === 'remove') {
      if (!currentPassword) {
        setError('Please enter the password.');
        return;
      }
    }

    if (mode === 'set' || mode === 'change') {
      if (mode === 'change' && !currentPassword) {
        setError('Please enter the current password.');
        return;
      }
      if (!newPassword) {
        setError('Please enter a password.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setBusy(true);
    try {
      await onSubmit({
        currentPassword: currentPassword || undefined,
        newPassword: newPassword || undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Could not verify password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="nn-dialog pw-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={titles[mode]}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(420px, 94vw)' }}
      >
        <header className="nn-head">
          <button className="nn-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
          <h2>
            <Lock size={16} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {titles[mode]}
          </h2>
          <div style={{ width: 34 }} />
        </header>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 6 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {mode === 'set' && (
              <>
                Protect <strong>{targetName}</strong> with an optional password. Other {targetKind}s remain unlocked.
              </>
            )}
            {mode === 'unlock' && (
              <>
                Enter the password for <strong>{targetName}</strong> to open it.
              </>
            )}
            {mode === 'change' && (
              <>
                Enter the current password for <strong>{targetName}</strong> and choose a new password.
              </>
            )}
            {mode === 'remove' && (
              <>
                Enter the current password to remove password protection from <strong>{targetName}</strong>.
              </>
            )}
          </div>

          {(mode === 'unlock' || mode === 'change' || mode === 'remove') && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              <span>{mode === 'change' ? 'Current Password' : 'Password'}</span>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="nn-input"
                  autoFocus
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter password"
                  style={{ width: '100%', paddingRight: 40 }}
                  aria-label={mode === 'change' ? 'Current Password' : 'Password'}
                />
                <button
                  type="button"
                  className="icon sm"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  style={{ position: 'absolute', right: 6 }}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
          )}

          {(mode === 'set' || mode === 'change') && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                <span>{mode === 'change' ? 'New Password' : 'Password'}</span>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="nn-input"
                    autoFocus={mode === 'set'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter password"
                    style={{ width: '100%', paddingRight: 40 }}
                    aria-label={mode === 'change' ? 'New Password' : 'Password'}
                  />
                  <button
                    type="button"
                    className="icon sm"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    style={{ position: 'absolute', right: 6 }}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                <span>Confirm Password</span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="nn-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  style={{ width: '100%' }}
                  aria-label="Confirm Password"
                />
              </label>

              <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
                Note: This {targetKind} is encrypted locally on your device. If you forget the password, it cannot be recovered.
              </p>
            </>
          )}

          {error && (
            <div role="alert" style={{ color: '#ff6b6b', fontSize: 13, fontWeight: 500 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="chip" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="nn-create" disabled={busy}>
              {busy
                ? 'Working…'
                : mode === 'set'
                  ? 'Done'
                  : mode === 'unlock'
                    ? 'Unlock'
                    : mode === 'change'
                      ? 'Save Password'
                      : 'Remove Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
