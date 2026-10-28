package com.gavalkadir.calcut;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static volatile boolean inForeground = false;

    static boolean isInForeground() {
        return inForeground;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(NativePushPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(BiometricKeyPlugin.class);
        super.onCreate(savedInstanceState);
        // No screenshots or screen recording, and a blank preview in the
        // recent-apps list, so messages never leak out of the app.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        applyLaunchIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applyLaunchIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
        // The app's own call screen takes over from the ringing notification.
        Notifier.cancelCall(this);
    }

    @Override
    public void onPause() {
        super.onPause();
        inForeground = false;
    }

    // Only an incoming call may show the app over the lock screen; the app's
    // own call screen answers it without unlocking the vault. Any other
    // launch puts the lock screen back in front.
    private void applyLaunchIntent(Intent intent) {
        setShowOverLockScreen(intent != null && intent.getBooleanExtra(Notifier.EXTRA_INCOMING_CALL, false));
    }

    void setShowOverLockScreen(boolean show) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(show);
            setTurnScreenOn(show);
        } else {
            int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (show) getWindow().addFlags(flags); else getWindow().clearFlags(flags);
        }
    }
}
