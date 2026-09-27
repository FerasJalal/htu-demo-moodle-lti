<?php
namespace local_rennixtutorbot\local;

defined('MOODLE_INTERNAL') || die();

use Firebase\JWT\JWT;
use mod_lti\local\ltiopenid\jwks_helper;

/**
 * Short-lived credential the page's Vimeo tracker sends with each position
 * report to rennix-lti (POST /lti/playback).
 *
 * Signed with this site's own LTI platform key -- the key rennix-lti already
 * trusts to verify launches (via /mod/lti/certs.php) -- so no extra shared
 * secret has to be provisioned. iss/aud/sub mirror an LTI launch (issuer =
 * wwwroot, audience = the Rennix Tutor Bot tool's client_id, subject = the
 * Moodle user id, which is what Moodle sends as `sub` in launches), and the
 * purpose claim stops it from being accepted anywhere an id_token is.
 */
class playback_token {
    /** Claim rennix-lti checks to tell these apart from LTI id_tokens. */
    const PURPOSE_CLAIM = 'https://rennix.ai/claim/purpose';
    const PURPOSE = 'video_playback';
    /** Lifetime; a page left open longer just stops reporting until reloaded. */
    const TTL = 4 * HOURSECS;

    /**
     * The site-level Rennix Tutor Bot External Tool this site launches, or null.
     *
     * Matched by tool URL host against the configured Rennix LTI URL, preferring
     * a tool whose name mentions "Tutor" when both Rennix products are installed.
     */
    public static function find_tool(): ?\stdClass {
        global $CFG, $DB;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');
        $ltiurl = trim((string) get_config('local_rennixtutorbot', 'rennixltiurl'));
        $host = $ltiurl ? parse_url($ltiurl, PHP_URL_HOST) : null;
        if (!$host) {
            return null;
        }
        $types = $DB->get_records_select('lti_types',
            'ltiversion = ? AND state = ? AND clientid IS NOT NULL AND ' . $DB->sql_like('baseurl', '?', false),
            ['1.3.0', LTI_TOOL_STATE_CONFIGURED, '%' . $DB->sql_like_escape($host) . '%'], 'id ASC', 'id, name, clientid');
        foreach ($types as $type) {
            if (stripos($type->name, 'tutor') !== false) {
                return $type;
            }
        }
        return $types ? reset($types) : null;
    }

    /**
     * Mints a token for the given user, or null if the site has no LTI key or
     * no Rennix tool configured yet.
     */
    public static function create(int $userid, int $courseid): ?string {
        global $CFG;
        $tool = self::find_tool();
        $key = jwks_helper::get_private_key();
        if (!$tool || empty($key['key']) || empty($key['kid'])) {
            return null;
        }
        $now = time();
        $payload = [
            'iss' => $CFG->wwwroot,
            'aud' => $tool->clientid,
            'sub' => (string) $userid,
            'iat' => $now,
            'exp' => $now + self::TTL,
            'course_id' => $courseid,
            self::PURPOSE_CLAIM => self::PURPOSE,
        ];
        return JWT::encode($payload, $key['key'], 'RS256', $key['kid']);
    }
}
