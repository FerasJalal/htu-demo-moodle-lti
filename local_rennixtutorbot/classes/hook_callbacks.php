<?php
namespace local_rennixtutorbot;

defined('MOODLE_INTERNAL') || die();

use core\hook\output\before_footer_html_generation;
use local_rennixtutorbot\local\playback_token;

/**
 * Hook callbacks for local_rennixtutorbot.
 */
class hook_callbacks {
    /**
     * Adds the Vimeo position tracker to course pages for logged-in users, so
     * the LTI Tutor Bot knows which second of which lecture video a student is
     * at when they ask a question (see js/vimeo_tracker.js).
     */
    public static function before_footer(before_footer_html_generation $hook): void {
        global $PAGE, $USER;
        if (!get_config('local_rennixtutorbot', 'enablevideotracking') || during_initial_install()) {
            return;
        }
        if (!isloggedin() || isguestuser() || empty($PAGE->course->id) || $PAGE->course->id == SITEID) {
            return;
        }
        $context = \context_course::instance($PAGE->course->id, IGNORE_MISSING);
        if (!$context || !is_enrolled($context, $USER, '', true)) {
            return;
        }
        $ltiurl = rtrim(trim((string) get_config('local_rennixtutorbot', 'rennixltiurl')), '/');
        if (!$ltiurl) {
            return;
        }
        try {
            $token = playback_token::create((int) $USER->id, (int) $PAGE->course->id);
        } catch (\Throwable $e) {
            debugging('local_rennixtutorbot: could not create playback token: ' . $e->getMessage(), DEBUG_DEVELOPER);
            return;
        }
        if (!$token) {
            return;
        }
        $launchurl = fn(?int $cmid) => $cmid
            ? (new \moodle_url('/mod/lti/launch.php', ['id' => $cmid, 'triggerview' => 0]))->out(false)
            : null;
        $chatcmid = self::chat_panel_cmid((int) $PAGE->course->id);
        // The Rennix dashboard goes at the top of the course page itself only.
        $oncoursepage = strpos((string) $PAGE->pagetype, 'course-view-') === 0;
        $config = json_encode([
            'endpoint' => $ltiurl . '/lti/playback',
            'token' => $token,
            // Framed next to each lecture video (see js/vimeo_tracker.js); null = no side panel.
            'chatUrl' => $launchurl($chatcmid),
            // Framed under each lecture video; it signs in through the panel's launch, so only with a panel.
            'knowledgeCheckUrl' => $chatcmid ? $ltiurl . '/embed/knowledge-check' : null,
            'dashboardUrl' => $oncoursepage ? $launchurl(self::main_tool_cmid((int) $PAGE->course->id)) : null,
        ], JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP);
        $src = (new \moodle_url('/local/rennixtutorbot/js/vimeo_tracker.js',
            ['v' => get_config('local_rennixtutorbot', 'version')]))->out(false);
        $hook->add_html('<script>window.RennixPlaybackConfig = ' . $config . ';</script>' .
            '<script src="' . s($src) . '" defer></script>');
    }

    /**
     * The course's Tutor Bot "video panel" activity: an External Tool instance of
     * the Rennix Tutor Bot with custom parameter rennix_view=chat (usually
     * hidden from the course page), which rennix-lti opens as just the chat
     * panel. Returns its cmid if the current user can launch it, else null.
     */
    public static function chat_panel_cmid(int $courseid): ?int {
        return self::tool_cmid($courseid, true);
    }

    /**
     * The course's regular Rennix Tutor Bot activity (no rennix_view parameter),
     * which launches the Rennix dashboard (student home / instructor dashboard).
     */
    public static function main_tool_cmid(int $courseid): ?int {
        return self::tool_cmid($courseid, false);
    }

    /**
     * First Rennix Tutor Bot activity in the course the current user can launch,
     * either the chat-panel companion (rennix_view=chat) or a regular one.
     */
    private static function tool_cmid(int $courseid, bool $chatpanel): ?int {
        global $DB;
        $tool = playback_token::find_tool();
        if (!$tool) {
            return null;
        }
        $like = $DB->sql_like('instructorcustomparameters', '?', false, true, !$chatpanel);
        $instances = $DB->get_records_select('lti',
            'course = ? AND typeid = ? AND (' . $like . ($chatpanel ? '' : ' OR instructorcustomparameters IS NULL') . ')',
            [$courseid, $tool->id, '%rennix_view=chat%'], 'id ASC', 'id');
        $cms = get_fast_modinfo($courseid)->get_instances_of('lti');
        foreach ($instances as $instance) {
            if (isset($cms[$instance->id]) && $cms[$instance->id]->available && $cms[$instance->id]->uservisible) {
                return (int) $cms[$instance->id]->id;
            }
        }
        return null;
    }
}
