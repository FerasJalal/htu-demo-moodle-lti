<?php
namespace local_rennixtutorbot\privacy;

defined('MOODLE_INTERNAL') || die();

use core_privacy\local\metadata\collection;

/**
 * Declares the video-position data sent to the Rennix LTI service.
 *
 * Only the Vimeo tracking is declared here; nothing it sends is stored in
 * Moodle, so there is no user data to export or delete on this side.
 */
class provider implements \core_privacy\local\metadata\provider, \core_privacy\local\request\data_provider {
    public static function get_metadata(collection $collection): collection {
        $collection->add_external_location_link('rennix', [
            'userid' => 'privacy:metadata:rennix:userid',
            'position' => 'privacy:metadata:rennix:position',
        ], 'privacy:metadata:rennix');
        return $collection;
    }
}
