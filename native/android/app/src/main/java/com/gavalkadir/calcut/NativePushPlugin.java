package com.gavalkadir.calcut;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Native FCM for the Android app. The WebView has no web push, so the app
 * gets an FCM token here and registers it with the push server exactly like
 * the website does with its web push token.
 */
@CapacitorPlugin(
    name = "NativePush",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NativePushPlugin extends Plugin {

    /** Firebase only starts when google-services.json was bundled at build time. */
    private boolean configured() {
        return !FirebaseApp.getApps(getContext()).isEmpty();
    }

    private boolean notificationsAllowed() {
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    private boolean fullScreenAllowed() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        return nm.canUseFullScreenIntent();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("configured", configured());
        r.put("notifications", notificationsAllowed());
        r.put("fullScreen", fullScreenAllowed());
        call.resolve(r);
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        if (!configured()) {
            call.reject("Firebase yapılandırılmamış (google-services.json yok)");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionCallback");
            return;
        }
        fetchToken(call);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("Bildirim izni verilmedi");
            return;
        }
        fetchToken(call);
    }

    private void fetchToken(PluginCall call) {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                Exception e = task.getException();
                call.reject("cihaz anahtarı alınamadı" + (e != null ? " (" + e.getMessage() + ")" : ""));
                return;
            }
            JSObject r = new JSObject();
            r.put("token", task.getResult());
            call.resolve(r);
        });
    }

    @PluginMethod
    public void deleteToken(PluginCall call) {
        if (!configured()) {
            call.resolve();
            return;
        }
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(task -> call.resolve());
    }

    /** Android 14+ asks the user to allow full-screen call alerts per app. */
    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                Uri.parse("package:" + getContext().getPackageName()));
        } else {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void cancelCallNotification(PluginCall call) {
        Notifier.cancelCall(getContext());
        call.resolve();
    }
}
