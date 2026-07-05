const LOGGER = require('@calzoneman/jsli')('database/tables');


export async function initTables() {
    const knex = require('../database').getDB().knex;

    async function ensureTable(name, structure) {
        if (!await knex.schema.hasTable(name)) {
            LOGGER.info('Creating table %s', name);
            await knex.schema.createTable(name, structure);
        }
    }

    // TODO: consider un-utf8ing columns that are always ASCII
    // Leaving for now for backwards compatibility

    // TODO: enforce foreign key constraints for tables missing them

    await ensureTable('users', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.string('name', 20).notNullable().unique();
        t.string('password', 60).notNullable();
        t.integer('global_rank').notNullable();
        t.string('email', 255);
        // UTF8MB4 required for non-BMP Unicode -- Just MySQL things (tm)
        t.specificType('profile', 'text character set utf8mb4 not null');
        t.string('ip', 39).notNullable();
        // Registration time, TODO convert to timestamp
        t.bigint('time').notNullable();
        t.string('name_dedupe', 20).defaultTo(null);
        t.boolean('inactive').defaultTo(false);
    });

    await ensureTable('channels', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.string('name', 30).notNullable().unique();
        t.string('owner', 20).notNullable().index();
        // Registration time, TODO convert to timestamp
        t.bigInteger('time').notNullable();
        t.timestamp('last_loaded').notNullable()
                .defaultTo(knex.raw('0'));
        t.timestamp('owner_last_seen').notNullable()
                .defaultTo(knex.raw('0'));
    });

    await ensureTable('channel_data', t => {
        t.charset('utf8');
        t.integer('channel_id').notNullable()
                .unsigned()
                .references('id').inTable('channels')
                .onDelete('cascade');
        t.string('key', 20).notNullable();
        t.specificType('value', 'mediumtext character set utf8mb4 not null');
        t.primary(['channel_id', 'key']);
    });

    await ensureTable('global_bans', t => {
        t.charset('utf8');
        t.string('ip', 39).notNullable().primary();
        t.string('reason', 255).notNullable();
    });

    await ensureTable('password_reset', t => {
        t.charset('utf8');
        t.string('ip', 39).notNullable();
        t.string('name', 20).notNullable().primary();
        t.string('hash', 64).notNullable();
        t.string('email', 255).notNullable();
        // TODO consider converting to timestamp
        t.bigint('expire').notNullable();
    });

    await ensureTable('user_playlists', t => {
        t.charset('utf8');
        t.string('user', 20).notNullable();
        t.string('name', 255).notNullable();
        t.specificType('contents', 'mediumtext character set utf8mb4 not null');
        t.integer('count').notNullable();
        t.integer('duration').notNullable();
        t.primary(['user', 'name']);
    });

    await ensureTable('aliases', t => {
        t.charset('utf8');
        t.increments('visit_id').notNullable().primary();
        t.string('ip', 39).notNullable().index();
        t.string('name', 20).notNullable();
        // TODO consider converting to timestamp
        t.bigint('time').notNullable();
    });

    await ensureTable('meta', t => {
        t.charset('utf8');
        t.string('key', 255).notNullable().primary();
        t.text('value').notNullable();
    });

    await ensureTable('channel_libraries', t => {
        t.charset('utf8');
        t.string('id', 255).notNullable();
        t.specificType('title', 'varchar(255) character set utf8mb4 not null');
        t.integer('seconds').notNullable();
        t.string('type', 2).notNullable();
        t.text('meta').notNullable();
        t.string('channel', 30).notNullable();
        t.primary(['id', 'channel']);
        // TODO replace title index with FTS or elasticsearch or something
        t.index(['channel', knex.raw('`title`(227)')], 'channel_libraries_channel_title');
    });

    await ensureTable('channel_ranks', t => {
        t.charset('utf8');
        t.string('name', 20).notNullable();
        t.integer('rank').notNullable();
        t.string('channel', 30).notNullable();
        t.primary(['name', 'channel']);
    });

    await ensureTable('channel_bans', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.string('ip', 39).notNullable();
        t.string('name', 20).notNullable();
        t.string('bannedby', 20).notNullable();
        t.specificType('reason', 'varchar(255) character set utf8mb4 not null');
        t.string('channel', 30).notNullable();
        t.unique(['name', 'ip', 'channel']);
        t.index(['ip', 'channel']);
        t.index(['name', 'channel']);
    });

    await ensureTable('user_deletion_requests', t => {
        t.increments('request_id').notNullable().primary();
        t.integer('user_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('users')
            .onDelete('cascade')
            .unique();
        t.timestamps(/* useTimestamps */ true, /* defaultToNow */ true);
        t.index('created_at');
    });

    await ensureTable('media_metadata_cache', t => {
        // The types of id and type are chosen for compatibility
        // with the existing channel_libraries table.
        // TODO in the future schema, revisit the ID layout for different media types.
        t.charset('utf8');
        t.string('id', 255).notNullable();
        t.string('type', 2).notNullable();
        t.text('metadata').notNullable();
        t.timestamps(/* useTimestamps */ true, /* defaultToNow */ true);

        t.primary(['type', 'id']);
        t.index('updated_at');
    });

    await ensureTable('channel_bots', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
                .unsigned()
                .notNullable()
                .references('id').inTable('channels')
                .onDelete('cascade');
        t.string('name', 20).notNullable();
        t.string('token_hash', 64).notNullable().unique();
        t.integer('rank').notNullable();
        t.string('created_by', 20).notNullable();
        t.bigInteger('created_at').notNullable();
        t.boolean('active').notNullable().defaultTo(true);
        t.bigInteger('last_connected').nullable();
        t.index('channel_id');
    });

    await ensureTable('channel_shows', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
                .unsigned()
                .notNullable()
                .references('id').inTable('channels')
                .onDelete('cascade');
        t.string('name', 100).notNullable();
        t.specificType('notes', 'mediumtext character set utf8mb4');
        t.string('color', 7).nullable();
        t.specificType('notification_plan', 'mediumtext character set utf8mb4');
        t.specificType('playlist', 'mediumtext character set utf8mb4 not null');
        t.string('timezone', 64).notNullable().defaultTo('UTC');
        t.bigInteger('scheduled_for').notNullable();
        t.bigInteger('estimated_end_at').nullable();
        t.bigInteger('next_run_at').notNullable();
        t.string('status', 20).notNullable().defaultTo('draft');
        t.string('recurrence', 20).notNullable().defaultTo('none');
        t.specificType('recurrence_meta', 'text character set utf8mb4');
        t.string('fill_mode', 20).notNullable().defaultTo('append');
        t.string('conflict_mode', 20).notNullable().defaultTo('force');
        t.boolean('start_playback').notNullable().defaultTo(false);
        t.integer('run_count').notNullable().defaultTo(0);
        t.bigInteger('last_run_at').nullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.string('created_by', 20).notNullable();
        t.string('updated_by', 20).notNullable();
        t.specificType('last_error', 'text character set utf8mb4');
        t.index(['channel_id', 'status', 'next_run_at'], 'channel_shows_due_idx');
        t.index(['channel_id', 'created_at'], 'channel_shows_channel_created_idx');
    });

    await ensureTable('banned_channels', t => {
        t.charset('utf8mb4');
        t.string('channel_name', 30)
            .notNullable()
            .unique();
        t.text('external_reason').notNullable();
        t.text('internal_reason').notNullable();
        t.string('banned_by', 20).notNullable();
        t.timestamps(/* useTimestamps */ true, /* defaultToNow */ true);
    });

    await ensureTable('channel_calendar_integrations', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channels')
            .onDelete('cascade');
        t.string('provider', 32).notNullable();
        t.string('status', 20).notNullable().defaultTo('disconnected');
        t.specificType('config_json', 'text character set utf8mb4');
        t.specificType('token_encrypted', 'text character set utf8mb4');
        t.specificType('refresh_token_encrypted', 'text character set utf8mb4');
        t.bigInteger('token_expires_at').nullable();
        t.bigInteger('last_sync_at').nullable();
        t.specificType('last_error', 'text character set utf8mb4');
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.string('connected_by', 20).nullable();
        t.string('updated_by', 20).nullable();
        t.unique(['channel_id', 'provider'], 'channel_calendar_integration_unique');
        t.index(['channel_id', 'provider'], 'channel_calendar_integration_lookup');
    });

    await ensureTable('channel_show_external_events', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channels')
            .onDelete('cascade');
        t.integer('show_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channel_shows')
            .onDelete('cascade');
        t.integer('integration_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channel_calendar_integrations')
            .onDelete('cascade');
        t.string('provider', 32).notNullable();
        t.string('external_event_id', 255).notNullable();
        t.string('external_etag', 255).nullable();
        t.bigInteger('last_pushed_at').nullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.unique(['show_id', 'integration_id'], 'channel_show_external_event_unique');
        t.index(['integration_id', 'provider'], 'channel_show_external_event_integration_idx');
    });

    await ensureTable('channel_google_event_index', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channels')
            .onDelete('cascade');
        t.integer('integration_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channel_calendar_integrations')
            .onDelete('cascade');
        t.integer('show_id').unsigned().nullable();
        t.string('external_event_id', 255).notNullable();
        t.string('external_etag', 255).nullable();
        t.bigInteger('start_at').nullable();
        t.bigInteger('updated_remote_at').nullable();
        t.bigInteger('last_seen_at').nullable();
        t.boolean('deleted_remote').notNullable().defaultTo(false);
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.unique(['integration_id', 'external_event_id'], 'channel_google_event_index_event_unique');
        t.index(['integration_id', 'show_id'], 'channel_google_event_index_show_idx');
    });

    await ensureTable('channel_notification_integrations', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channels')
            .onDelete('cascade');
        t.string('provider', 32).notNullable();
        t.string('name', 100).notNullable();
        t.string('status', 20).notNullable().defaultTo('connected');
        t.specificType('config_json', 'text character set utf8mb4');
        t.specificType('token_encrypted', 'text character set utf8mb4');
        t.specificType('last_error', 'text character set utf8mb4');
        t.string('connected_by', 20).nullable();
        t.string('updated_by', 20).nullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.index(['channel_id', 'provider', 'status'], 'channel_notification_integration_lookup');
    });

    await ensureTable('channel_show_notification_deliveries', t => {
        t.charset('utf8');
        t.increments('id').notNullable().primary();
        t.integer('channel_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channels')
            .onDelete('cascade');
        t.integer('show_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channel_shows')
            .onDelete('cascade');
        t.integer('integration_id')
            .unsigned()
            .notNullable()
            .references('id').inTable('channel_notification_integrations')
            .onDelete('cascade');
        t.string('provider', 32).notNullable();
        t.bigInteger('occurrence_at').notNullable();
        t.integer('offset_minutes').notNullable();
        t.string('status', 20).notNullable().defaultTo('pending');
        t.integer('attempts').notNullable().defaultTo(0);
        t.bigInteger('last_attempt_at').nullable();
        t.bigInteger('sent_at').nullable();
        t.specificType('last_error', 'text character set utf8mb4');
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.unique(
            ['show_id', 'integration_id', 'occurrence_at', 'offset_minutes'],
            'channel_show_notification_delivery_unique'
        );
        t.index(['status', 'updated_at'], 'channel_show_notification_delivery_status_idx');
    });
}
