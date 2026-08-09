# Show Notifications and Custom Webhooks

Channel admins can configure notification targets from **Channel Settings > Integrations > Notifications**. Shows can then select those targets from each notification step in **Channel Settings > Shows**.

## Notification Flow

1. Create a notification target, such as Discord, ntfy.sh, or Custom Webhook.
2. Create or edit a show.
3. Add one or more notification steps.
4. Set `X minutes before start`, the message template, and the target IDs.
5. Use **Test notification** before relying on the schedule.

The scheduler renders the step's message at send time. For Custom Webhook targets, that rendered message is also available to the webhook body template.

## Custom Webhook Targets

Custom Webhook targets let the show scheduler call an HTTP endpoint, such as a bot API, before a show starts.

The Custom Webhook form supports:

- **Webhook URL**: `http://` or `https://` endpoint. Localhost and private network destinations are blocked.
- **HTTP Verb**: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- **Headers JSON**: non-secret headers, stored in plain integration config.
- **Body Template**: request body rendered for each notification send.
- **Content Type**: defaults to `application/json`.
- **Bearer Token**: stored encrypted and sent as `Authorization: Bearer ...`.
- **Secret Headers JSON**: stored encrypted and not shown again after saving.

Secrets require the existing integration encryption key configuration. Leave bearer token and secret headers blank when editing to keep the saved secrets.

## Body Template Example

Use `_json` placeholders when inserting values inside JSON strings.

```json
{
  "event": "show_notification",
  "message": "{notification_message_json}",
  "show_name": "{show_name_json}",
  "channel_name": "{channel_name_json}",
  "starts_at": "{start_time_iso_json}",
  "offset_minutes": "{offset_minutes_json}",
  "show_url": "{show_url_json}",
  "notes": "{notes_text_json}"
}
```

With this setup, each show notification step can have its own message while the Custom Webhook integration keeps one reusable JSON body. Your bot reads `message` and decides what to do.

## Template Placeholders

Notification message templates and Custom Webhook body templates support:

| Placeholder | Meaning |
|-------------|---------|
| `{show_name}` | Show name |
| `{channel_name}` | Channel name |
| `{start_time}` | Localized show start time using the show's timezone |
| `{start_time_iso}` | ISO-8601 show start timestamp |
| `{time_until}` | Human-readable offset, such as `30 minutes`, `1 hour`, or `now` |
| `{offset_minutes}` | Numeric offset in minutes |
| `{show_url}` | Channel show URL |
| `{notes}`, `{note}`, `{show_notes}` | Notes formatted for notification clients, preserving useful image/link URLs |
| `{notes_text}`, `{note_text}`, `{show_notes_text}` | Notes with Markdown links and formatting removed |
| `{notes_markdown}`, `{note_markdown}`, `{show_notes_markdown}` | Raw show notes Markdown |
| `{message}` | Rendered notification step message, for Custom Webhook body/header templates |
| `{notification_message}` | Alias for the rendered notification step message |

Custom Webhook body and secret header templates also support a JSON-safe variant for each placeholder by adding `_json`, for example `{show_name_json}`, `{notes_text_json}`, or `{notification_message_json}`. These variants escape quotes, backslashes, and newlines for insertion inside JSON strings.

## Security Notes

Custom Webhook requests are sent by the server, not by the browser. To reduce risk, the server rejects localhost and private-network destinations, blocks server-managed headers such as `Host` and `Content-Length`, caps request/response sizes, and uses a short timeout.
