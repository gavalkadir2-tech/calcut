package com.gavalkadir.calcut;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Receives the push server's data-only pushes (worker/_worker.js,
 * apps-script/Code.gs): { kind: "message" | "call" | "call-missed" | "test" }.
 * Data-only pushes reach this service even when the app is closed.
 * While the app is open it shows its own alarm and call screen, so nothing
 * is shown here then.
 */
public class CalcutMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String kind = data.get("kind");
        if ("call-missed".equals(kind)) {
            Notifier.showMissedCall(this);
            return;
        }
        if (MainActivity.isInForeground()) return;
        if ("call".equals(kind)) {
            Notifier.showIncomingCall(this);
        } else {
            Notifier.showMessage(this);
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // The app re-registers its current token with the push server every
        // time it signs in, so there's nothing to store here.
    }
}
