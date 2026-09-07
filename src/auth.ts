import { 
  signInWithPopup, 
  signInWithRedirect, 
  getRedirectResult, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User 
} from 'firebase/auth';
import { auth } from './lib/db';

const provider = new GoogleAuthProvider();
provider.setCustomParameters({
  prompt: 'select_account'
});

// Initialize auth state listener. Call this on app load.
export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void
) => {
  // Check if returning from a redirect auth flow
  try {
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user && onAuthSuccess) {
          onAuthSuccess(result.user, null);
        }
      })
      .catch((err) => {
        console.warn('Redirect sign-in notice:', err?.message || err);
      });
  } catch (e) {
    // Ignore environments where redirect is unhandled
  }

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (onAuthSuccess) onAuthSuccess(user, null);
    } else {
      if (onAuthFailure) onAuthFailure();
    }
  });
};

let signInPromise: Promise<{ success: boolean; error?: string }> | null = null;

// Must be called from a button click or user interaction
export const googleSignIn = async (): Promise<{ success: boolean; error?: string }> => {
  if (signInPromise) {
    return signInPromise;
  }
  signInPromise = (async () => {
    try {
      await signInWithPopup(auth, provider);
      return { success: true };
    } catch (error: any) {
      const code = error?.code || '';
      const message = error?.message || '';
      
      // User closed popup or cancelled
      if (
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/popup-blocked' ||
        message.includes('popup-closed-by-user') ||
        message.includes('INTERNAL ASSERTION FAILED') ||
        message.includes('Pending promise')
      ) {
        console.log('Sign in popup dismissed or closed.');
        return { success: false, error: 'Sign-in cancelled or popup was closed.' };
      }

      // Network / iframe restrictions
      if (code === 'auth/network-request-failed' || message.includes('network-request-failed')) {
        console.warn('Firebase auth iframe/network notice:', message);
        return { 
          success: false, 
          error: 'Sign-in network error. If using an embedded preview, please open the app in a new tab or allow popups.' 
        };
      }

      console.warn('Sign-in notice:', error?.message || error);
      return { success: false, error: error?.message || 'Authentication could not be completed.' };
    } finally {
      signInPromise = null;
    }
  })();
  return signInPromise;
};

export const logout = async () => {
  await auth.signOut();
};

