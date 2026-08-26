import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();

// Initialize auth state listener. Call this on app load.
export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (onAuthSuccess) onAuthSuccess(user, null);
    } else {
      if (onAuthFailure) onAuthFailure();
    }
  });
};

let signInPromise: Promise<void> | null = null;

// Must be called from a button click or user interaction
export const googleSignIn = async (): Promise<void> => {
  if (signInPromise) {
    return signInPromise;
  }
  signInPromise = (async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      const code = error?.code || '';
      const message = error?.message || '';
      if (
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/popup-blocked' ||
        message.includes('popup-closed-by-user') ||
        message.includes('INTERNAL ASSERTION FAILED') ||
        message.includes('Pending promise')
      ) {
        console.log('Sign in popup closed or cancelled by user.');
        return;
      }
      console.error('Sign in error:', error);
      throw error;
    } finally {
      signInPromise = null;
    }
  })();
  return signInPromise;
};

export const logout = async () => {
  await auth.signOut();
};
