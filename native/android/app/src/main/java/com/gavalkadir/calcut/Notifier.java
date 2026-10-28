package com.gavalkadir.calcut;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * System notifications for pushes that arrive while the app is closed.
 * Like sw.js on the web, they are disguised as an alarm and never name the
 * sender.
 */
final class Notifier {

    static final String EXTRA_INCOMING_CALL = "calcut_incoming_call";

    private static final String CHANNEL_MESSAGES = "alarm-messages";
    private static final String CHANNEL_CALLS = "alarm-calls";
    // A channel's sound can't change once created, so each sound choice in
    // Settings (AlarmSoundPlugin) has its own channel.
    private static final String CHANNEL_MESSAGES_ALARM = "alarm-messages-alarmtone";
    private static final String CHANNEL_CALLS_ALARM = "alarm-calls-alarmtone";
    private static final String CHANNEL_MESSAGES_SILENT = "alarm-messages-silent";
    private static final String CHANNEL_CALLS_SILENT = "alarm-calls-silent";
    private static final int ID_MESSAGE = 1;
    private static final int ID_CALL = 2;
    // Matches the TTL the push server gives call pushes.
    private static final long CALL_RING_MS = 45_000;

    private Notifier() {}

    static void showMessage(Context ctx) {
        ensureChannels(ctx);
        NotificationCompat.Builder b = base(ctx, messageChannel(ctx), "Alarm", openAppIntent(ctx, false))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true);
        manager(ctx).notify(ID_MESSAGE, b.build());
    }

    static void showIncomingCall(Context ctx) {
        ensureChannels(ctx);
        PendingIntent open = openAppIntent(ctx, true);
        NotificationCompat.Builder b = base(ctx, callChannel(ctx), "Alarm", open)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setFullScreenIntent(open, true)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(CALL_RING_MS)
            // Re-ring pushes refresh the notification without restarting the sound.
            .setOnlyAlertOnce(true);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // keep ringing until answered or dismissed
        manager(ctx).notify(ID_CALL, n);
    }

    static void showMissedCall(Context ctx) {
        ensureChannels(ctx);
        cancelCall(ctx);
        NotificationCompat.Builder b = base(ctx, messageChannel(ctx), "Kaçırılan alarm", openAppIntent(ctx, false))
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true);
        manager(ctx).notify(ID_CALL, b.build());
    }

    private static String messageChannel(Context ctx) {
        switch (AlarmSoundPlugin.soundFor(ctx, "message")) {
            case "alarm": return CHANNEL_MESSAGES_ALARM;
            case "silent": return CHANNEL_MESSAGES_SILENT;
            default: return CHANNEL_MESSAGES;
        }
    }

    private static String callChannel(Context ctx) {
        switch (AlarmSoundPlugin.soundFor(ctx, "call")) {
            case "alarm": return CHANNEL_CALLS_ALARM;
            case "silent": return CHANNEL_CALLS_SILENT;
            default: return CHANNEL_CALLS;
        }
    }

    static void cancelCall(Context ctx) {
        manager(ctx).cancel(ID_CALL);
    }

    private static NotificationCompat.Builder base(Context ctx, String channel, String title, PendingIntent open) {
        String time = new SimpleDateFormat("HH:mm", Locale.forLanguageTag("tr-TR")).format(new Date());
        return new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle(title)
            .setContentText(time)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open);
    }

    private static PendingIntent openAppIntent(Context ctx, boolean incomingCall) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_INCOMING_CALL, incomingCall);
        return PendingIntent.getActivity(ctx, incomingCall ? 1 : 0, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static NotificationManager manager(Context ctx) {
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = manager(ctx);
        if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_MESSAGES, "Alarmlar", NotificationManager.IMPORTANCE_HIGH);
            c.enableVibration(true);
            c.setVibrationPattern(new long[] {0, 300, 150, 300, 150, 300});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_MESSAGES_ALARM) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_MESSAGES_ALARM, "Alarmlar (telefonun alarm sesi)", NotificationManager.IMPORTANCE_HIGH);
            c.setSound(AlarmSoundPlugin.alarmUri(), AlarmSoundPlugin.alarmAttributes());
            c.enableVibration(true);
            c.setVibrationPattern(new long[] {0, 300, 150, 300, 150, 300});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_CALLS_ALARM) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_CALLS_ALARM, "Çalan alarmlar (telefonun alarm sesi)", NotificationManager.IMPORTANCE_HIGH);
            c.setSound(AlarmSoundPlugin.alarmUri(), AlarmSoundPlugin.alarmAttributes());
            c.enableVibration(true);
            c.setVibrationPattern(new long[] {0, 800, 400, 800, 400, 800, 400, 800});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_MESSAGES_SILENT) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_MESSAGES_SILENT, "Alarmlar (sessiz)", NotificationManager.IMPORTANCE_HIGH);
            c.setSound(null, null);
            c.enableVibration(true);
            c.setVibrationPattern(new long[] {0, 300, 150, 300, 150, 300});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_CALLS_SILENT) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_CALLS_SILENT, "Çalan alarmlar (sessiz)", NotificationManager.IMPORTANCE_HIGH);
            c.setSound(null, null);
            c.enableVibration(true);
            c.setVibrationPattern(new long[] {0, 800, 400, 800, 400, 800, 400, 800});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_CALLS) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_CALLS, "Çalan alarmlar", NotificationManager.IMPORTANCE_HIGH);
            c.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            c.enableVibration(true);
            c.setVibrationPattern(new long[] {0, 800, 400, 800, 400, 800, 400, 800});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
    }
}
